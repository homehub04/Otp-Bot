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
// Two more things that cause "incorrect code" / "couldn't link device":
//   1. Browser fingerprint must use Baileys' Browsers.* helper. A raw
//      ['Ubuntu','Chrome','x.x.x'] array is rejected by WA's pairing
//      validation on current server versions.
//   2. Any half-registered auth state left over from a failed attempt has
//      to be wiped before requesting a new code — reusing it makes WA see
//      a conflicting session and invalidate the fresh code.
//   3. fetchLatestBaileysVersion() has a known bug where it reports a stale
//      WA Web version while claiming isLatest:true — that stale version
//      lets a code get generated but WA refuses to complete the link
//      ("Couldn't link device"). Use fetchLatestWaWebVersion() instead.
//
// Session persistence (ported from Scotty_C's lib/bucket.js): if
// S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY are set, the paired
// session is mirrored to an S3-compatible bucket (R2/B2/S3/Supabase) on
// every creds update, and restored from there on boot. This means the
// sending number survives a Render restart/redeploy even without paying
// for a persistent disk — if those env vars aren't set, this is a total
// no-op and behavior is unchanged.

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
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  delay
} = require('@whiskeysockets/baileys');
const bucket = require('./lib/bucket');

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

// DEBUG=true in .env turns on Baileys' own internal protocol logging
// (every frame sent/received) instead of swallowing it silently. This is
// how you see the REAL reason a pairing attempt failed — statusCode alone
// isn't enough, the raw disconnect reason/message underneath it is.
const DEBUG = process.env.DEBUG === 'true';
const baileysLogLevel = DEBUG ? 'debug' : 'silent';

// Reverse-lookup so logs show a name ("loggedOut") instead of a bare number
// (401) for whichever DisconnectReason fired.
const DISCONNECT_REASON_NAMES = Object.fromEntries(
  Object.entries(DisconnectReason).map(([name, code]) => [code, name])
);

// Last real error seen, surfaced via /api/status so it shows up in the
// browser too, not just the terminal — set on any pairing failure or
// unexpected disconnect, cleared on a successful connect.
let lastError = null;

function describeDisconnect(lastDisconnect) {
  const err = lastDisconnect?.error;
  const statusCode = err?.output?.statusCode;
  return {
    statusCode: statusCode ?? null,
    reason: DISCONNECT_REASON_NAMES[statusCode] || 'unknown',
    message: err?.message || null,
    // err.output.payload often carries WhatsApp's actual server-side reason
    payload: err?.output?.payload || null,
    // The raw stream:error node (if any) — this is the ground truth for
    // "why" when it's a WhatsApp-side rejection, not a network error.
    data: err?.data || null
  };
}

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

// Wipes AUTH_DIR (local + bucket copy). Only ever called when we're not
// connected, so there's nothing live to lose — this guarantees every
// pairing-code request starts from a clean slate instead of fighting
// stale/half-registered creds, and stops a dead session from resurrecting
// itself on the next boot.
async function wipeAuthDir() {
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
  await bucket.deleteBucketSession();
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
    const { version } = await fetchLatestWaWebVersion({});

    const newSock = makeWASocket({
      version,
      logger: pino({ level: baileysLogLevel }),
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
    newSock.ev.on('creds.update', async () => {
      await saveCreds();
      bucket.uploadSession(AUTH_DIR); // ☁️ debounced sync — don't hammer the bucket
    });

    newSock.ev.on('connection.update', (update) => {
      if (sock !== newSock) return; // stale listener from a socket we already replaced
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        isConnected = true;
        lastError = null;
        logger.info('WhatsApp connected');
        bucket.uploadSessionNow(AUTH_DIR); // ☁️ persist immediately on first connect
      }

      if (connection === 'close') {
        isConnected = false;
        const detail = describeDisconnect(lastDisconnect);
        const loggedOut = detail.statusCode === DisconnectReason.loggedOut;
        lastError = { at: new Date().toISOString(), stage: 'connection', ...detail };
        // Full detail always logged — this is the "real error", not just a
        // status code. With DEBUG=true you also get every raw frame above it.
        logger.warn(detail, 'Connection closed');

        if (loggedOut) {
          logger.error('Session logged out — clearing AUTH_DIR and bucket; re-pair from GET /.');
          wipeAuthDir().catch((e) => logger.error(e, 'Failed to clear session after logout'));
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
    logger.info({ phone }, 'Requesting pairing code');
    try {
      const rawCode = await newSock.requestPairingCode(phone);
      const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      logger.info({ phone, code: formatted }, 'Pairing code issued — enter this on the phone within 60s');
      lastError = null;
      return formatted;
    } catch (e) {
      // This is the REAL error from WhatsApp's server for this request —
      // not just "incorrect code". Log everything we've got.
      const detail = {
        message: e?.message,
        data: e?.data,
        output: e?.output,
        stack: e?.stack
      };
      lastError = { at: new Date().toISOString(), stage: 'requestPairingCode', phone, ...detail };
      logger.error(detail, 'requestPairingCode failed');
      throw e;
    }
  } finally {
    connecting = false;
  }
}

// Reconnects using already-registered creds (e.g. after a network drop or
// on boot from a restored session), WITHOUT wiping AUTH_DIR and WITHOUT
// requesting a new pairing code.
async function reconnectRegistered() {
  if (connecting) return;
  connecting = true;
  try {
    await closeCurrentSocket();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestWaWebVersion({});

    const newSock = makeWASocket({
      version,
      logger: pino({ level: baileysLogLevel }),
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
    newSock.ev.on('creds.update', async () => {
      await saveCreds();
      bucket.uploadSession(AUTH_DIR);
    });
    newSock.ev.on('connection.update', (update) => {
      if (sock !== newSock) return;
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        isConnected = true;
        lastError = null;
        logger.info('WhatsApp reconnected');
        bucket.uploadSessionNow(AUTH_DIR);
      }
      if (connection === 'close') {
        isConnected = false;
        const detail = describeDisconnect(lastDisconnect);
        const loggedOut = detail.statusCode === DisconnectReason.loggedOut;
        lastError = { at: new Date().toISOString(), stage: 'reconnect', ...detail };
        logger.warn(detail, 'Connection closed');
        if (loggedOut) {
          logger.error('Session logged out — clearing AUTH_DIR and bucket; re-pair from GET /.');
          wipeAuthDir().catch((e) => logger.error(e, 'Failed to clear session after logout'));
        } else if (sock === newSock) {
          reconnectRegistered().catch((e) => logger.error(e, 'Auto-reconnect failed'));
        }
      }
    });
  } finally {
    connecting = false;
  }
}

// Boot: restore the session from the bucket if there's no local copy, then
// reconnect quietly if it's registered. Otherwise wait for the user to hit
// "Get code" on GET / — no QR fallback.
(async () => {
  try {
    const hasLocalAuth = await fs.access(AUTH_DIR).then(() => true).catch(() => false);
    if (!hasLocalAuth) {
      await bucket.downloadSession(AUTH_DIR); // ☁️ no-op if bucket disabled or nothing saved
    }
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
  res.json({ connected: isConnected, lastError });
});

// POST /api/pair-code — body: { phone }
app.post('/api/pair-code', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (isConnected) return res.status(400).json({ error: 'Already connected' });
  if (connecting) return res.status(429).json({ error: 'A connection attempt is already in progress — wait a moment and try again' });

  const digits = String(phone).replace(/[^\d]/g, '');
  // Must be a full international number: country code + subscriber number,
  // no leading 0. Catches the #1 real cause of "incorrect code" reports:
  // someone typing a local-format number (e.g. 0771234567) instead of the
  // full E.164 form (263771234567) — WhatsApp still hands back *a* code for
  // it, but it can never actually complete pairing since it's not a real
  // international number, which looks identical to "incorrect code" on the
  // phone.
  if (digits.startsWith('0') || digits.length < 10 || digits.length > 15) {
    return res.status(400).json({
      error: 'That number looks off — use the full international format: country code + number, no leading 0 and no +, e.g. 263771234567 (not 0771234567)'
    });
  }

  try {
    const code = await connectSocket({ phone: digits });
    res.json({ code, expiresInSeconds: 60 });
  } catch (e) {
    logger.error({ message: e?.message, data: e?.data, output: e?.output, stack: e?.stack }, 'Failed to request pairing code');
    res.status(502).json({ error: e.message || 'Failed to request pairing code — check the number and try again', debug: DEBUG ? { message: e?.message, data: e?.data, output: e?.output } : undefined });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected, lastError });
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
