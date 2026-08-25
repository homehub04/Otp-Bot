/**
 * lib/bucket.js — S3-compatible bucket sync for the WhatsApp session.
 * Keeps the sending number paired across Render restarts/redeploys even
 * without a persistent disk. Works with Cloudflare R2, Backblaze B2, AWS S3,
 * Supabase Storage, etc. Ported from Scotty_C's per-user version, collapsed
 * to a single session since this bot only ever pairs one sending number.
 *
 * Optional: if S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY
 * aren't set, this quietly no-ops and the bot behaves exactly as before
 * (relying on AUTH_DIR / a persistent disk only).
 */
const fs = require('fs');
const AdmZip = require('adm-zip');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const ENABLED = !!(
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY &&
  process.env.S3_SECRET_KEY
);

const BUCKET = process.env.S3_BUCKET;
const KEY = 'sessions/otp-bot.zip';

let s3 = null;
if (ENABLED) {
  s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY
    },
    forcePathStyle: true // required by R2 / B2 / Supabase
  });
  console.log(`☁️  Session bucket ENABLED — ${BUCKET}`);
} else {
  console.log('☁️  Session bucket DISABLED — set S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY to enable persistence');
}

function zipFolder(dir) {
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  return zip.toBuffer();
}

function unzipToFolder(buffer, dir) {
  fs.mkdirSync(dir, { recursive: true });
  new AdmZip(buffer).extractAllTo(dir, true);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ── debounced upload — creds.update fires a lot, don't hammer the bucket ───
let pendingUpload = null;

function uploadSession(authDir, delayMs = 4000) {
  if (!ENABLED) return;
  if (pendingUpload) clearTimeout(pendingUpload);
  pendingUpload = setTimeout(() => {
    pendingUpload = null;
    uploadSessionNow(authDir).catch(() => {});
  }, delayMs);
}

// ── immediate upload — used right after connect + on shutdown ──────────────
async function uploadSessionNow(authDir) {
  if (!ENABLED) return;
  if (!fs.existsSync(authDir)) return;
  try {
    const buffer = zipFolder(authDir);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      Body: buffer,
      ContentType: 'application/zip'
    }));
    console.log('☁️  Synced session → bucket');
  } catch (e) {
    console.error('☁️  Upload failed:', e.message);
  }
}

// ── restore the session from the bucket, if one exists ─────────────────────
async function downloadSession(authDir) {
  if (!ENABLED) return false;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
    const buffer = await streamToBuffer(res.Body);
    unzipToFolder(buffer, authDir);
    console.log('☁️  Restored session ← bucket');
    return true;
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) {
      console.error('☁️  Download failed:', e.message);
    }
    return false;
  }
}

// ── wipe the bucket copy (on logout, or before a fresh pairing attempt) ────
async function deleteBucketSession() {
  if (!ENABLED) return;
  if (pendingUpload) { clearTimeout(pendingUpload); pendingUpload = null; }
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }));
    console.log('☁️  Deleted session from bucket');
  } catch (e) {
    console.error('☁️  Bucket delete failed:', e.message);
  }
}

module.exports = {
  ENABLED,
  uploadSession,
  uploadSessionNow,
  downloadSession,
  deleteBucketSession
};
