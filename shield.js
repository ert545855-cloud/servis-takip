'use strict';
/*
 * API kalkanı: uygulamanın kendi istemcisiyle sunucu arasındaki JSON trafiği okunamaz hale getirilir.
 * Biçim: [0x55, bayrak, tuz(4 bayt), veri...]  bayrak bit0 = deflate-raw ile sıkıştırılmış.
 * Veri, derleme anında üretilen (ya da API_SHIELD_KEY ortam değişkeninden gelen) anahtar ve her mesajda
 * değişen tuzla xorshift akışından geçirilir. Bu bir gizleme katmanıdır; asıl güvenlik oturum, yetki ve
 * hız sınırı kontrolleridir.
 */
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

function loadKey() {
  let b64 = process.env.API_SHIELD_KEY || '';
  if (!b64) { try { b64 = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist', 'shield.json'), 'utf8')).key || ''; } catch { /* derleme yok */ } }
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  if (key.length < 16) return null;
  const kid = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  let h = 0x811c9dc5; for (const x of key) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; }
  return { key, kid, k32: h >>> 0 };
}
const SH = loadKey();

function xorInPlace(buf, salt) {
  const s32 = (salt[0] | (salt[1] << 8) | (salt[2] << 16) | (salt[3] << 24)) >>> 0;
  let x = (SH.k32 ^ s32) >>> 0 || 0x9e3779b9; const K = SH.key; const kl = K.length; const n = buf.length;
  for (let i = 0; i < n; i += 4) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    buf[i] ^= (x & 255) ^ K[i % kl];
    if (i + 1 < n) buf[i + 1] ^= ((x >>> 8) & 255) ^ K[(i + 1) % kl];
    if (i + 2 < n) buf[i + 2] ^= ((x >>> 16) & 255) ^ K[(i + 2) % kl];
    if (i + 3 < n) buf[i + 3] ^= ((x >>> 24) & 255) ^ K[(i + 3) % kl];
  }
  return buf;
}
async function encode(obj, allowDeflate) {
  let buf = Buffer.from(JSON.stringify(obj === undefined ? null : obj), 'utf8'); let fl = 0;
  if (allowDeflate && buf.length > 1400) { buf = await deflateRaw(buf, { level: 5 }); fl = 1; }
  const salt = crypto.randomBytes(4); xorInPlace(buf, salt);
  return Buffer.concat([Buffer.from([0x55, fl]), salt, buf]);
}
function encodeSync(obj) { const buf = Buffer.from(JSON.stringify(obj), 'utf8'); const salt = crypto.randomBytes(4); xorInPlace(buf, salt); return Buffer.concat([Buffer.from([0x55, 0]), salt, buf]); }
async function decode(raw) {
  if (!raw || raw.length < 6 || raw[0] !== 0x55) throw new Error('bad');
  const fl = raw[1]; const body = Buffer.from(raw.subarray(6)); xorInPlace(body, raw.subarray(2, 6));
  const out = fl & 1 ? await inflateRaw(body, { maxOutputLength: 64 * 1024 * 1024 }) : body;
  return JSON.parse(out.toString('utf8'));
}
const BIG = /^\/api\/(import\/|backup\/restore)/;
function middleware(req, res, next) {
  const h = req.headers['x-us']; if (!h || !SH) return next();
  const [ver, kid] = String(h).split('.');
  if (kid !== SH.kid) { res.setHeader('Cache-Control', 'no-store'); return res.status(409).json({ error: 'Uygulama güncellendi, sayfa yenileniyor', reload: true }); }
  const deflate = ver === '2';
  const json = res.json.bind(res);
  res.json = obj => {
    encode(obj, deflate).then(buf => {
      if (res.headersSent) return;
      res.setHeader('Content-Type', 'application/x-us'); res.setHeader('Cache-Control', 'no-store'); res.end(buf);
    }).catch(() => { if (!res.headersSent) json(obj); });
    return res;
  };
  if (String(req.headers['content-type'] || '').startsWith('application/x-us')) {
    const limit = BIG.test(req.originalUrl || req.url) ? 26 * 1024 * 1024 : 1024 * 1024;
    const chunks = []; let size = 0; let done = false;
    req.on('data', c => { if (done) return; size += c.length; if (size > limit) { done = true; res.status(413).json({ error: 'Gönderilen veri çok büyük' }); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (done) return; done = true;
      decode(Buffer.concat(chunks)).then(obj => { req.body = obj; req._body = true; next(); }).catch(() => res.status(400).json({ error: 'Geçersiz istek' })); });
    req.on('error', () => { done = true; });
    return;
  }
  next();
}
/* canlı olay akışı: "data: {...}" satırları kodlanır */
function wrapSSE(req, res) {
  if (!SH || req.query.x !== SH.kid) return;
  const w = res.write.bind(res);
  res.write = (chunk, ...a) => {
    if (typeof chunk === 'string' && chunk.startsWith('data: ') && chunk.endsWith('\n\n')) {
      try { chunk = 'data: ~' + encodeSync(JSON.parse(chunk.slice(6, -2))).toString('base64') + '\n\n'; } catch { /* olduğu gibi gönder */ }
    }
    return w(chunk, ...a);
  };
}
module.exports = { SH, middleware, wrapSSE, encode, decode };
