// index.js — Baileys WhatsApp OTP bot.
//
// Purpose: a tiny standalone service Nzvimbo's main server calls over HTTP to
// deliver OTP codes via WhatsApp, using your own WhatsApp number as the
// sender (Baileys = unofficial WhatsApp Web protocol, free, no Meta approval
// needed). This is the "free" path we discussed — the tradeoff is it's
// against WhatsApp's ToS, so treat it as a dev/fallback channel, not the
// only OTP path in production. See README.md for deployment + Render notes.
//
// Web pairing: open "/" in a browser. It offers both a scannable QR and a
// phone-number pairing code (WhatsApp > Linked Devices > Link with phone
// number instead), so you can link the sending number without needing
// terminal/log access on Render.
//
// IMPORTANT: only ONE Baileys socket may exist at a time for a given
// AUTH_DIR. Every reconnect / pairing-code request goes through
// connectSocket() below, which always closes whatever socket is currently
// open before creating a new one. Letting two sockets race to register the
// same number against WhatsApp's servers is what causes "incorrect code" —
// WhatsApp sees a conflicting session and invalidates the code, even though
// the code itself was generated correctly.

require('dotenv').config();
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // required header for /send-otp
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const BROWSER_FINGERPRINT = ['Ubuntu', 'Chrome', '20.0.04'];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let sock = null;          // the ONE live socket, if any
let latestQR = null;      // data URL of the current pairing QR, or null once connected
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

// Single entry point for starting a socket, whether for the passive QR flow
// (no args) or an on-demand pairing-code request ({ phone }). Always closes
// any existing socket first so only one registration attempt is ever live.
async function connectSocket({ phone } = {}) {
  if (connecting) throw new Error('A connection attempt is already in progress');
  connecting = true;

  try {
    await closeCurrentSocket();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const newSock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
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
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        QRCode.toDataURL(qr).then((dataUrl) => { latestQR = dataUrl; });
        isConnected = false;
      }

      if (connection === 'open') {
        isConnected = true;
        latestQR = null;
        logger.info('WhatsApp connected');
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, 'Connection closed');

        if (loggedOut) {
          logger.error('Session logged out — delete AUTH_DIR and re-pair from GET /.');
        } else if (sock === newSock) {
          // network hiccup — reconnect the passive QR flow automatically.
          // (Not done for pairing-code sockets; the user retries manually.)
          connectSocket().catch((e) => logger.error(e, 'Auto-reconnect failed'));
        }
      }
    });

    if (phone) {
      await delay(2000); // let the socket settle before requesting a code
      const rawCode = await newSock.requestPairingCode(phone);
      return rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    }

    return null;
  } finally {
    connecting = false;
  }
}

// Boot into the passive QR flow by default.
connectSocket().catch((e) => logger.error(e, 'Failed to start WhatsApp socket'));

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
  res.json({ connected: isConnected, hasQR: !!latestQR });
});

app.get('/api/qr', (req, res) => {
  if (isConnected) return res.json({ qr: null });
  res.json({ qr: latestQR });
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

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.type('text/plain').send('Already connected — no QR needed.');
  }
  if (!latestQR) {
    return res.type('text/plain').send('QR not generated yet — wait a few seconds and refresh.');
  }
  const img = Buffer.from(latestQR.split(',')[1], 'base64');
  res.type('png').send(img);
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
