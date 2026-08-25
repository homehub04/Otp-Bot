# Nzvimbo OTP Bot (Baileys)

A tiny standalone WhatsApp bot that sends OTP codes, using your own WhatsApp
number as the sender via Baileys (unofficial WhatsApp Web protocol — free,
no Meta Business approval needed). Your main Nzvimbo server calls this
service over HTTP whenever it needs to deliver a code.

**Free, but read this first:** Baileys rides on the unofficial WhatsApp Web
protocol, which is against WhatsApp's Terms of Service. The sending number
can get banned, especially at higher volume or if recipients mark messages
as spam. Treat this as your dev/low-volume/free path, with the Meta Cloud
API as the eventual production path once you're past ~1,000 OTPs/month.
Use a spare WhatsApp number for this, not your personal one.

## What it exposes

- `GET /` — **the pairing page.** Open this once after first deploy. It
  shows a scannable QR *and* a phone-number field for WhatsApp's "Link with
  phone number instead" flow, auto-refreshes while waiting, and flips to a
  "Connected" state once paired.
- `GET /health` — status check, returns `{ ok: true, connected: true|false }`
- `GET /qr` — raw QR image (PNG), kept for scripting/API use; the pairing
  page above is the one you'll actually use in a browser.
- `POST /send-otp` — body `{ "phone": "263771234567", "code": "482913" }`,
  header `x-api-key: <API_KEY>`. Sends the OTP text and returns
  `{ "sent": true }`.

## Local test

```bash
cp .env.example .env      # edit API_KEY to something random
npm install
npm start
```

Then open `http://localhost:3000` in a browser, scan the QR (or use the
phone-number pairing code option) with the sending
WhatsApp number, and once `/health` shows `connected: true`, test with:

```bash
curl -X POST http://localhost:3000/send-otp \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your API_KEY>" \
  -d '{"phone":"2637XXXXXXXX","code":"123456"}'
```

## Deploying on Render

**Important — persistent disk is required.** Render's default filesystem is
wiped on every deploy/restart. Without a persistent disk, `AUTH_DIR` (your
WhatsApp session) gets deleted every time the service restarts, and you'd
have to re-scan the QR code constantly — unusable in production.

1. Push this folder to its own GitHub repo (keep it separate from the main
   Nzvimbo repo — it's a different service).
2. On Render: **New → Web Service** → connect the repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: at minimum the smallest **paid** instance — Render's
     free web services spin down on idle, which drops the WhatsApp socket
     and disks aren't available on the free tier at all.
3. Add a **persistent disk**: Render dashboard → your service → *Disks* →
   Add Disk. Mount path `/data`, size 1GB is plenty.
4. Environment variables (Render dashboard → *Environment*):
   - `API_KEY` — same random string your main server will send
   - `AUTH_DIR` — `/data/auth_info` (must match the disk mount path above)
   - `PORT` — Render sets this automatically, no need to add it
5. Deploy. Once live, open `https://<your-service>.onrender.com` in a
   browser and pair the sending WhatsApp number (QR or phone-number code).
6. Confirm `https://<your-service>.onrender.com/health` shows
   `"connected": true`. From then on the session persists across restarts
   because it's on the disk, not the ephemeral filesystem.

If you ever need to relink a different number, delete the contents of the
disk's `auth_info` folder (Render shell: `rm -rf /data/auth_info/*`) and
restart the service — it'll generate a fresh QR at `/qr`.

## Wiring it into Nzvimbo's main server

In the main `nzvimbo-server` repo, set two env vars:

```
OTP_BOT_URL=https://<your-otp-bot>.onrender.com
OTP_BOT_API_KEY=<same value as API_KEY above>
```

Then `utils/whatsapp.js`'s `sendWhatsAppOTP()` calls
`POST ${OTP_BOT_URL}/send-otp` with that key. See that file's comments for
the exact fetch call.
