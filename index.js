// index.js — Baileys WhatsApp OTP bot.
//
// Purpose: a tiny standalone service Nzvimbo's main server calls over HTTP to
// deliver OTP codes via WhatsApp, using your own WhatsApp number as the
// sender (Baileys = unofficial WhatsApp Web protocol, free, no Meta approval
// needed). This is the "free" path we discussed — the tradeoff is it's
// against WhatsApp's ToS, so treat it as a dev/fallback channel, not the
// only OTP path in production. See README.md for deployment + Render notes.
//
// Pairing: phone-number pairing code ONLY (no QR). Open "/" in a browser,
// enter the sending number, and type the 8-character code into WhatsApp >
// Linked Devices > Link a Device > Link with phone number instead.
//
// IMPORTANT: only ONE Baileys socket may exist at a time for a given
// AUTH_DIR. Every reconnect / pairing-code request goes through
// connectSocket() below, which always closes whatever socket is currently
// open before creating a new one. Letting two sockets race to register the
// same number against WhatsApp's servers is what causes "incorrect code" —
// WhatsApp sees a conflicting session and invalidates the code, even though
// the code itself was generated correctly.
//
// Two more things that cause "incorrect code" specifically:
//   1. Browser fingerprint must use Baileys' Browsers.* helper. A raw
//      ['Ubuntu','Chrome','x.x.x'] array is rejected by WA's pairing
//      validation on current server versions.
//   2. Any half-registered auth state left over from a failed attempt has
//      to be wiped before requesting a new code — reusing it makes WA see
//      a conflicting session and invalidate the fresh code.

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  delay
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // required header for /send-otp
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
// Correct fingerprint format — DO NOT replace with a raw array, that's what
// was causing "incorrect code". Browsers.ubuntu() returns the right shape.
const BROWSER_FINGERPRINT = Browsers.ubuntu('Chrome');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let sock = null;          // the ONE live socket, if any
let isConnected = false;
let connecting = false;   // guards against overlapping connectSocket() calls

// Closes the current socket (if any) and waits briefly for the underlying
// websocket to actually tear down before the caller opens a new one.
async function closeCurrentSocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    sock.end(new Error('replaced by a new connection'));
  } catch (e) {
    logger.warn(e, 'Error while closing previous socket (non-fatal)');
  }
  sock = null;
  isConnected = false;
  await delay(500);
}

// Wipes AUTH_DIR. Only ever called when we're not connected, so there's
// nothing live to lose — this guarantees every pairing-code request starts
// from a clean slate instead of fighting stale/half-registered creds.
async function wipeAuthDir() {
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
}

// Single entry point for starting a socket for an on-demand pairing-code
// request. Always closes any existing socket first so only one registration
// attempt is ever live, and always starts from a fresh AUTH_DIR.
async function connectSocket({ phone }) {
  if (connecting) throw new Error('A connection attempt is already in progress');
  connecting = true;

  try {
    await closeCurrentSocket();
    await wipeAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const newSock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      browser: BROWSER_FINGERPRINT,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      msgRetryCounterCache: new NodeCache(),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
      }
    });

    sock = newSock;
    newSock.ev.on('creds.update', saveCreds);

    newSock.ev.on('connection.update', (update) => {
      if (sock !== newSock) return; // stale listener from a socket we already replaced
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        isConnected = true;
        logger.info('WhatsApp connected');
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, 'Connection closed');

        if (loggedOut) {
          logger.error('Session logged out — delete AUTH_DIR and re-pair from GET /.');
        } else if (sock === newSock && isConnected === false && newSock.authState?.creds?.registered) {
          // network hiccup on an already-registered session — reconnect quietly.
          reconnectRegistered().catch((e) => logger.error(e, 'Auto-reconnect failed'));
        }
      }
    });

    // Docs recommend not calling requestPairingCode the instant the socket
    // is created — give it a beat to finish its handshake first.
    await delay(2000);
    if (newSock.authState.creds.registered) {
      // Shouldn't happen right after a wipe, but guard anyway.
      return null;
    }
    const rawCode = await newSock.requestPairingCode(phone);
    return rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
  } finally {
    connecting = false;
  }
}

// Reconnects using already-registered creds (e.g. after a network drop),
// WITHOUT wiping AUTH_DIR and WITHOUT requesting a new pairing code.
async function reconnectRegistered() {
  if (connecting) return;
  connecting = true;
  try {
    await closeCurrentSocket();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const newSock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      browser: BROWSER_FINGERPRINT,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      msgRetryCounterCache: new NodeCache(),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
      }
    });

    sock = newSock;
    newSock.ev.on('creds.update', saveCreds);
    newSock.ev.on('connection.update', (update) => {
      if (sock !== newSock) return;
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        isConnected = true;
        logger.info('WhatsApp reconnected');
      }
      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          logger.error('Session logged out — delete AUTH_DIR and re-pair from GET /.');
        } else if (sock === newSock) {
          reconnectRegistered().catch((e) => logger.error(e, 'Auto-reconnect failed'));
        }
      }
    });
  } finally {
    connecting = false;
  }
}

// Boot: if we already have a registered session on disk, reconnect quietly.
// Otherwise wait for the user to hit "Get code" on GET / — no QR fallback.
(async () => {
  try {
    const { state } = await useMultiFileAuthState(AUTH_DIR);
    if (state.creds?.registered) {
      await reconnectRegistered();
    }
  } catch (e) {
    logger.error(e, 'Startup check failed');
  }
})();

// ---- Helpers ----
function toWhatsAppId(rawPhone) {
  const digits = String(rawPhone).replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: API_KEY not set' });
  }
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }
  next();
}

// ---- Pairing / status routes (used by public/index.html) ----

app.get('/api/status', (req, res) => {
  res.json({ connected: isConnected });
});

// POST /api/pair-code — body: { phone }
app.post('/api/pair-code', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (isConnected) return res.status(400).json({ error: 'Already connected' });
  if (connecting) return res.status(429).json({ error: 'A connection attempt is already in progress — wait a moment and try again' });

  const digits = String(phone).replace(/[^\d]/g, '');
  if (/^263 0|^2630/.test(digits) || digits.length < 10) {
    return res.status(400).json({
      error: 'That number looks off — use country code + number with no leading 0 and no +, e.g. 263771234567'
    });
  }

  try {
    const code = await connectSocket({ phone: digits });
    res.json({ code, expiresInSeconds: 60 });
  } catch (e) {
    logger.error(e, 'Failed to request pairing code');
    res.status(502).json({ error: e.message || 'Failed to request pairing code — check the number and try again' });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

app.post('/send-otp', requireApiKey, async (req, res) => {
  const { phone, code } = req.body || {};
  if (!phone || !code) {
    return res.status(400).json({ error: 'phone and code are required' });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected yet — open GET / to pair' });
  }

  try {
    const jid = toWhatsAppId(phone);
    await sock.sendMessage(jid, {
      text: `Your Nzvimbo verification code is *${code}*. It expires in 10 minutes. Don't share this code with anyone.`
    });
    res.json({ sent: true });
  } catch (e) {
    logger.error(e, 'Failed to send OTP');
    res.status(502).json({ error: 'Failed to send WhatsApp message' });
  }
});

app.listen(PORT, () => {
  logger.info(`OTP bot listening on :${PORT}`);
});
