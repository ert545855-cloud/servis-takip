'use strict';
/* Statik dosyalar: bellekte tutulur, brotli/gzip ile sıkıştırılmış gönderilir, ETag ile 304 döner. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const COMPRESS = /\.(html|js|css|svg|webmanifest|json|txt|wasm)$/i;
const SKIP = new Set(['shield.json']);

function load(dir) {
  const files = new Map();
  const walk = (d, base) => {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n); const st = fs.statSync(f);
      if (st.isDirectory()) { walk(f, base + n + '/'); continue; }
      // önceden sıkıştırılmış eşler (x.br / x.gz) yalnızca asıl dosya varsa atlanır; tek başına .gz dosyası olduğu gibi sunulur
      if ((/\.(br|gz)$/i.test(n) && fs.existsSync(f.replace(/\.(br|gz)$/i, ''))) || SKIP.has(n) || n.startsWith('.')) continue;
      const raw = fs.readFileSync(f); const ext = path.extname(n).toLowerCase();
      const e = { raw, type: TYPES[ext] || 'application/octet-stream', tag: crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) };
      if (COMPRESS.test(n) && raw.length > 1024) {
        e.br = fs.existsSync(f + '.br') ? fs.readFileSync(f + '.br') : zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > 400000 ? 5 : 8 } });
        e.gz = fs.existsSync(f + '.gz') ? fs.readFileSync(f + '.gz') : zlib.gzipSync(raw, { level: 8 });
      }
      files.set('/' + base + n, e);
    }
  };
  walk(dir, '');
  return files;
}
function cacheFor(p) {
  if (p === '/index.html' || p === '/sw.js' || p === '/manifest.webmanifest') return 'no-cache';
  if (p.startsWith('/vendor/')) return 'public, max-age=604800, stale-while-revalidate=2592000';
  if (/\.(png|svg|ico|jpg)$/i.test(p)) return 'public, max-age=86400, stale-while-revalidate=604800';
  return 'no-cache';
}
module.exports = function mountStatic(app, dir) {
  const files = load(dir);
  function send(req, res, p) {
    const f = files.get(p); if (!f) return false;
    const ae = String(req.headers['accept-encoding'] || '');
    let body = f.raw, enc = '';
    if (f.br && /\bbr\b/.test(ae)) { body = f.br; enc = 'br'; } else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; enc = 'gzip'; }
    const etag = `"${f.tag}${enc ? '-' + enc : ''}"`;
    res.setHeader('Content-Type', f.type); res.setHeader('Cache-Control', cacheFor(p)); res.setHeader('ETag', etag);
    if (f.br || f.gz) res.setHeader('Vary', 'Accept-Encoding');
    if (p === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map(x => x.trim().replace(/^W\//, '')).includes(etag)) { res.statusCode = 304; res.end(); return true; }
    if (enc) res.setHeader('Content-Encoding', enc);
    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(body); return true;
  }
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p; try { p = decodeURIComponent(req.path); } catch { return next(); }
    if (p === '/') p = '/index.html';
    if (p.includes('..') || p.startsWith('/api/')) return next();
    if (!send(req, res, p)) next();
  });
  const total = [...files.values()].reduce((a, f) => a + f.raw.length, 0);
  console.log(`Statik dosyalar: ${path.basename(dir)}/ · ${files.size} dosya · ${(total / 1024).toFixed(0)} KB`);
  return { sendIndex: (req, res) => send(req, res, '/index.html') || res.status(404).end() };
};
