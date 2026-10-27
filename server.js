'use strict';
/*
 * Servis Takip Panosu — sunucu
 * Tek HTML arayüzü (public/index.html) sunar, verileri PostgreSQL'de tutar,
 * değişiklikleri Server-Sent Events ile tüm açık ekranlara anında iletir.
 *
 * Ortam değişkenleri:
 *   DATABASE_URL     PostgreSQL bağlantı adresi (zorunlu)
 *   ADMIN_USERNAME   İlk yönetici kullanıcı adı (kullanıcı yokken oluşturulur)
 *   ADMIN_PASSWORD   İlk yönetici şifresi
 *   SEED_JSON        (isteğe bağlı) Veritabanı boşken içe aktarılacak veriler
 *   DB_SCHEMA        (isteğe bağlı) Tabloların tutulacağı şema, varsayılan "servis"
 *   PORT             Dinlenecek port (Render otomatik verir)
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL tanımlı değil'); process.exit(1); }
const isLocal = /localhost|127\.0\.0\.1|\/var\/run|host=\//.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 8 });
// Pano tablolarını ayrı bir şemada tutar; aynı veritabanını kullanan başka projelerin tablolarına dokunmaz.
const DB_SCHEMA = /^[a-z_][a-z0-9_]{0,40}$/.test(process.env.DB_SCHEMA || '') ? process.env.DB_SCHEMA : 'servis';
pool.on('connect', client => { client.query(`SET search_path TO ${DB_SCHEMA}`).catch(() => {}); });

const COLLS = new Set(['tickets', 'firms', 'customers', 'categories', 'products', 'settings']);
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_FILE = 15 * 1024 * 1024;
const SESSION_DAYS = 30;
const ROLES = new Set(['admin', 'user', 'viewer']);

/* ---------------- helpers ---------------- */
const newId = (n = 20) => crypto.randomBytes(n).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n).toLowerCase() || crypto.randomUUID().replace(/-/g, '');
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function checkPass(pw, stored) {
  try {
    const [, salt, h] = String(stored).split('$');
    const a = Buffer.from(h, 'hex');
    const b = crypto.scryptSync(String(pw), salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_\-.:@+~]{1,120}$/.test(s);
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });

/* ---------------- schema ---------------- */
async function migrate() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS docs (
      coll TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (coll, id));
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      data BYTEA NOT NULL, uploaded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const u = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const p = process.env.ADMIN_PASSWORD;
    if (!p) console.warn('Kullanıcı yok ve ADMIN_PASSWORD tanımlı değil: giriş yapılamayacak.');
    else {
      await pool.query('INSERT INTO users (id, username, name, pass, role) VALUES ($1,$2,$3,$4,$5)',
        [newId(), u, process.env.ADMIN_NAME || 'Yönetici', hashPass(p), 'admin']);
      console.log('İlk yönetici oluşturuldu:', u);
    }
  }
  const docs = await pool.query('SELECT count(*)::int AS n FROM docs');
  if (docs.rows[0].n === 0 && process.env.SEED_JSON) {
    try {
      const seed = JSON.parse(process.env.SEED_JSON);
      let n = 0;
      for (const [coll, items] of Object.entries(seed)) {
        if (!COLLS.has(coll) || !Array.isArray(items)) continue;
        for (const it of items) {
          if (!it || !validId(it.id)) continue;
          const { id, ...data } = it;
          await pool.query('INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [coll, id, data]);
          n++;
        }
      }
      console.log('Başlangıç verisi içe aktarıldı:', n, 'belge');
    } catch (e) { console.error('SEED_JSON okunamadı:', e.message); }
  }
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}

/* ---------------- realtime (SSE) ---------------- */
const clients = new Set();
function broadcast(evt) {
  const msg = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch { clients.delete(c); } } }, 25000);

/* ---------------- app ---------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  const tok = parseCookies(req).sid;
  if (!tok) return res.status(401).json({ error: 'Giriş gerekli' });
  const { rows } = await pool.query(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()', [tok]);
  if (!rows[0]) return res.status(401).json({ error: 'Oturum süresi doldu' });
  req.user = rows[0];
  next();
}
const canWrite = (req, res, next) => (req.user.role === 'viewer' ? res.status(403).json({ error: 'Görüntüleme yetkiniz var, değişiklik yapamazsınız' }) : next());
const isAdmin = (req, res, next) => (req.user.role !== 'admin' ? res.status(403).json({ error: 'Bu işlem için yönetici olmalısınız' }) : next());
// Basit CSRF koruması: değiştiren istekler yalnızca kendi sitemizden gelsin
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Geçersiz kaynak' });
  next();
}
app.use('/api', sameOrigin);

app.get('/healthz', (req, res) => res.send('ok'));

/* auth */
const loginTries = new Map();
app.post('/api/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const ip = req.ip || 'x';
  const t = loginTries.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 10) return res.status(429).json({ error: 'Çok fazla deneme yapıldı, 15 dakika sonra tekrar deneyin' });
  const username = String(req.body.username || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const u = rows[0];
  if (!u || !checkPass(req.body.password || '', u.pass)) {
    t.n++; loginTries.set(ip, t);
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  }
  loginTries.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [token, u.id]);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${req.secure ? '; Secure' : ''}`);
  res.json({ me: publicUser(u) });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const tok = parseCookies(req).sid;
  if (tok) await pool.query('DELETE FROM sessions WHERE token = $1', [tok]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
}));
app.post('/api/me/password', express.json({ limit: '10kb' }), wrap(auth), wrap(async (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!checkPass(current || '', req.user.pass)) return res.status(400).json({ error: 'Mevcut şifre hatalı' });
  if (!nw || String(nw).length < 6) return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı' });
  await pool.query('UPDATE users SET pass = $1 WHERE id = $2', [hashPass(nw), req.user.id]);
  res.json({ ok: true });
}));

/* bootstrap: tüm veriler */
app.get('/api/bootstrap', wrap(auth), wrap(async (req, res) => {
  const [docs, users] = await Promise.all([
    pool.query('SELECT coll, id, data FROM docs'),
    pool.query('SELECT id, username, name, role FROM users ORDER BY name'),
  ]);
  const data = { tickets: [], firms: [], customers: [], categories: [], products: [], settings: [] };
  for (const r of docs.rows) (data[r.coll] = data[r.coll] || []).push({ id: r.id, ...r.data });
  res.json({ me: publicUser(req.user), users: users.rows, data });
}));

/* realtime */
app.get('/api/events', wrap(auth), (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', clients: clients.size + 1 })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

/* documents */
function checkDoc(req, res) {
  const { coll, id } = req.params;
  if (!COLLS.has(coll) || !validId(id)) { res.status(400).json({ error: 'Geçersiz kayıt yolu' }); return false; }
  return true;
}
const jsonBody = express.json({ limit: '1mb' });
app.put('/api/docs/:coll/:id', jsonBody, wrap(auth), canWrite, wrap(async (req, res) => {
  if (!checkDoc(req, res)) return;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Geçersiz veri' });
  delete body.id;
  const { rows } = await pool.query(
    `INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3)
     ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING data`,
    [req.params.coll, req.params.id, body]);
  const doc = { id: req.params.id, ...rows[0].data };
  broadcast({ type: 'doc', coll: req.params.coll, id: req.params.id, doc });
  res.json(doc);
}));
app.patch('/api/docs/:coll/:id', jsonBody, wrap(auth), canWrite, wrap(async (req, res) => {
  if (!checkDoc(req, res)) return;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Geçersiz veri' });
  delete body.id;
  const { rows } = await pool.query(
    'UPDATE docs SET data = data || $3::jsonb, updated_at = now() WHERE coll = $1 AND id = $2 RETURNING data',
    [req.params.coll, req.params.id, JSON.stringify(body)]);
  if (!rows[0]) return res.status(404).json({ error: 'Kayıt bulunamadı' });
  const doc = { id: req.params.id, ...rows[0].data };
  broadcast({ type: 'doc', coll: req.params.coll, id: req.params.id, doc });
  res.json(doc);
}));
app.delete('/api/docs/:coll/:id', wrap(auth), canWrite, wrap(async (req, res) => {
  if (!checkDoc(req, res)) return;
  await pool.query('DELETE FROM docs WHERE coll = $1 AND id = $2', [req.params.coll, req.params.id]);
  broadcast({ type: 'doc', coll: req.params.coll, id: req.params.id, doc: null });
  res.json({ ok: true });
}));

/* files */
app.post('/api/files', wrap(auth), canWrite, express.raw({ type: () => true, limit: MAX_FILE }), wrap(async (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!FILE_TYPES.has(type)) return res.status(415).json({ error: 'Yalnızca JPG, PNG, WEBP, GIF ve PDF yüklenebilir' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Dosya boş' });
  let name = 'dosya';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'dosya')).slice(0, 200); } catch {}
  const id = newId(24);
  await pool.query('INSERT INTO files (id, name, type, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, name, type, req.body.length, req.body, req.user.id]);
  res.json({ id, size: req.body.length, type, name });
}));
app.get('/api/files/:id', wrap(auth), wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).end();
  const { rows } = await pool.query('SELECT name, type, data FROM files WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].type);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.send(rows[0].data);
}));
app.delete('/api/files/:id', wrap(auth), canWrite, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).end();
  await pool.query('DELETE FROM files WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* users (yönetici) */
app.get('/api/users', wrap(auth), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, name, role, created_at FROM users ORDER BY name');
  res.json(rows);
}));
app.post('/api/users', express.json({ limit: '10kb' }), wrap(auth), isAdmin, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const role = ROLES.has(req.body.role) ? req.body.role : 'user';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-32 karakter olmalı; harf, rakam, nokta, tire kullanın' });
  if (!name) return res.status(400).json({ error: 'Ad soyad girin' });
  if (password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  try {
    const id = newId();
    await pool.query('INSERT INTO users (id, username, name, pass, role) VALUES ($1,$2,$3,$4,$5)', [id, username, name, hashPass(password), role]);
    const u = { id, username, name, role };
    broadcast({ type: 'user', user: u });
    res.json(u);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Bu kullanıcı adı zaten var' });
    throw e;
  }
}));
app.patch('/api/users/:id', express.json({ limit: '10kb' }), wrap(auth), isAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  const name = req.body.name != null ? String(req.body.name).trim() : u.name;
  const role = ROLES.has(req.body.role) ? req.body.role : u.role;
  if (u.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'Kendi yönetici yetkinizi kaldıramazsınız' });
  let pass = u.pass;
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
    pass = hashPass(req.body.password);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  }
  await pool.query('UPDATE users SET name = $1, role = $2, pass = $3 WHERE id = $4', [name || u.name, role, pass, u.id]);
  const out = { id: u.id, username: u.username, name: name || u.name, role };
  broadcast({ type: 'user', user: out });
  res.json(out);
}));
app.delete('/api/users/:id', wrap(auth), isAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  broadcast({ type: 'user-removed', id: req.params.id });
  res.json({ ok: true });
}));

/* page */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Dosya çok büyük (en fazla 15 MB)' });
  console.error(err);
  res.status(500).json({ error: 'Sunucu hatası' });
});

migrate().then(() => {
  app.listen(PORT, () => console.log('Servis Takip Panosu çalışıyor, port', PORT));
}).catch(e => { console.error('Veritabanı hazırlanamadı:', e); process.exit(1); });
