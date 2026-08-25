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

require('dotenv').config();
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // required header for /send-otp
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let sock = null;
let latestQR = null;      // data URL of the current pairing QR, or null once connected
let isConnected = false;
let pairingInFlight = false;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // keep Baileys' own noisy logs out of yours
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome') // most reliable fingerprint for the phone-number pairing flow
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await QRCode.toDataURL(qr);
      isConnected = false;
      logger.info('New pairing QR generated — open GET / to scan or get a pairing code');
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
      } else {
        // network hiccup / restart — reconnect automatically
        startSock().catch((e) => logger.error(e, 'Reconnect failed'));
      }
    }
  });
}

startSock().catch((e) => logger.error(e, 'Failed to start WhatsApp socket'));

// ---- Helpers ----
function toWhatsAppId(rawPhone) {
  // Expects E.164-ish input, e.g. "263771234567" or "+263771234567".
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

// GET /api/status — polled by the pairing page every few seconds
app.get('/api/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!latestQR });
});

// GET /api/qr — current QR as a data URL (for the <img> tag on the pairing page)
app.get('/api/qr', (req, res) => {
  if (isConnected) return res.json({ qr: null });
  res.json({ qr: latestQR });
});

// POST /api/pair-code — body: { phone } — returns a code to type into
// WhatsApp > Linked Devices > Link with phone number instead.
app.post('/api/pair-code', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (isConnected) return res.status(400).json({ error: 'Already connected' });
  if (!sock) return res.status(503).json({ error: 'Socket not ready yet, try again shortly' });
  if (pairingInFlight) return res.status(429).json({ error: 'A pairing request is already in progress' });

  const digits = String(phone).replace(/[^\d]/g, '');

  // Catches the most common mistake: keeping the local leading 0 after the
  // country code (e.g. Zimbabwe 0771234567 -> should be 263771234567, not
  // 2630771234567). Not foolproof for every country, but flags the classic case.
  if (/^263 0|^2630/.test(digits) || digits.length < 10) {
    return res.status(400).json({
      error: 'That number looks off — use country code + number with no leading 0 and no +, e.g. 263771234567'
    });
  }

  try {
    pairingInFlight = true;
    const code = await sock.requestPairingCode(digits);
    res.json({ code, expiresInSeconds: 60 });
  } catch (e) {
    logger.error(e, 'Failed to request pairing code');
    res.status(502).json({ error: 'Failed to request pairing code — check the number and try again' });
  } finally {
    pairingInFlight = false;
  }
});

// GET /qr — legacy direct-image endpoint (kept for convenience / API use)
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

// GET /health — Render health check + quick status
app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

// POST /send-otp — body: { phone, code }
// Header: x-api-key: <API_KEY>
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
