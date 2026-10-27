'use strict';
/*
 * Ümraniye Şampiyonları — sunucu
 * Tek HTML arayüzü (public/index.html) sunar, verileri PostgreSQL'de tutar,
 * değişiklikleri Server-Sent Events ile açık ekranlara anında iletir.
 *
 * Ortam değişkenleri:
 *   DATABASE_URL     PostgreSQL bağlantı adresi (zorunlu)
 *   DB_SCHEMA        Tabloların tutulacağı şema (varsayılan "servis")
 *   ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_NAME   İlk yönetici (kullanıcı yokken oluşturulur)
 *   SEED_JSON        Veritabanı boşken içe aktarılacak başlangıç verileri
 *   APP_URL          Sitenin adresi (e-posta bağlantıları için), ör. https://site.onrender.com
 *   BIRD_API_KEY     Bird e-posta API anahtarı (bk_eu1_… / bk_us1_…)
 *   MAIL_FROM        Gönderen adres (varsayılan onboarding@messagebird.dev)
 *   MAIL_FROM_NAME   Gönderen adı (varsayılan "Ümraniye Şampiyonları")
 *   VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT   Telefon bildirimleri için anahtarlar
 *   PORT             Dinlenecek port
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
let webpush = null;
try { webpush = require('web-push'); } catch { /* isteğe bağlı */ }

const APP_NAME = 'Ümraniye Şampiyonları';
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL tanımlı değil'); process.exit(1); }
const isLocal = /localhost|127\.0\.0\.1|\/var\/run|host=\//.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 8 });
const DB_SCHEMA = /^[a-z_][a-z0-9_]{0,40}$/.test(process.env.DB_SCHEMA || '') ? process.env.DB_SCHEMA : 'servis';
pool.on('connect', client => { client.query(`SET search_path TO ${DB_SCHEMA}`).catch(() => {}); });

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const BIRD_KEY = process.env.BIRD_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@messagebird.dev';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || APP_NAME;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const pushReady = !!(webpush && VAPID_PUBLIC && process.env.VAPID_PRIVATE);
if (pushReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE);

const COLLS = new Set(['tickets', 'firms', 'customers', 'categories', 'products', 'settings', 'requests', 'branches', 'shipments']);
const SELLER_READ = new Set(['requests', 'branches']);
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_FILE = 15 * 1024 * 1024;
const SESSION_DAYS = 30;
const ROLES = new Set(['admin', 'user', 'satici', 'viewer']);
const ACTIVE_T = new Set(['teslim_alindi', 'servise_gonderildi', 'serviste', 'servisten_geldi', 'musteriye_teslim', 'fatura_talep', 'acik', 'islemde', 'parca']);
const REQ_LABEL = { yeni: 'Yeni talep', talep_edildi: 'Talep edildi', yolda: 'Yolda', geldi: 'Şubeye geldi', tamamlandi: 'Tamamlandı', iptal: 'Karşılanamadı / iptal' };
const SELLER_FIELDS = new Set(['productName', 'productCode', 'qty', 'fromBranch', 'purpose', 'customerName', 'customerPhone', 'note', 'neededBy', 'priority', 'updatedAt', 'log', 'comments', 'status']);

/* ---------------- helpers ---------------- */
const newId = (n = 20) => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.randomBytes(n)].map(b => a[b % 36]).join('');
};
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function checkPass(pw, stored) {
  try {
    const [, salt, h] = String(stored).split('$');
    const a = Buffer.from(h, 'hex'); const b = crypto.scryptSync(String(pw), salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_\-.:@+~]{1,120}$/.test(s);
const validEmail = s => typeof s === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, email: u.email || null, branch: u.branch || null, phone: u.phone || null, status: u.status || 'active' });
const baseUrl = req => APP_URL || `${req.protocol}://${req.get('host')}`;
function istNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
  const g = t => (parts.find(p => p.type === t) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24, minute: Number(g('minute')), weekday: g('weekday') };
}
function trDate(s) { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}.${m}.${y}`; }
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }

/* ---------------- e-posta ---------------- */
async function sendMail({ to, subject, html, text }) {
  if (!BIRD_KEY || !to) return { ok: false, reason: 'no_key' };
  const region = (BIRD_KEY.match(/^bk_([a-z]{2}\d+)_/) || [])[1] || 'us1';
  try {
    const r = await fetch(`https://${region}.platform.bird.com/v1/email/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BIRD_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { email: MAIL_FROM, name: MAIL_FROM_NAME }, to: [to], subject, html, text, category: 'transactional', track_opens: false, track_clicks: false }),
    });
    if (!r.ok) { const body = await r.text().catch(() => ''); console.warn('E-posta gönderilemedi', to, r.status, body.slice(0, 300)); return { ok: false, reason: 'rejected', status: r.status }; }
    console.log('E-posta gönderildi:', to, subject);
    return { ok: true };
  } catch (e) { console.warn('E-posta hatası', e.message); return { ok: false, reason: 'network' }; }
}
function mailLayout(title, bodyHtml, cta) {
  return `<!doctype html><html><body style="margin:0;background:#EEF2F1;font-family:Segoe UI,Arial,sans-serif;color:#15201E">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#0F2E2C;color:#fff;border-radius:14px 14px 0 0;padding:18px 22px;font-weight:800;font-size:18px">🏆 ${esc(APP_NAME)}</div>
    <div style="background:#fff;border:1px solid #D3DDDB;border-top:0;border-radius:0 0 14px 14px;padding:22px">
      <h1 style="font-size:19px;margin:0 0 12px">${esc(title)}</h1>
      <div style="font-size:15px;line-height:1.55">${bodyHtml}</div>
      ${cta ? `<p style="margin:22px 0 6px"><a href="${esc(cta.url)}" style="background:#0D6B68;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p><p style="font-size:12px;color:#6b7b78;word-break:break-all">Düğme çalışmazsa bu adresi tarayıcıya yapıştırın: ${esc(cta.url)}</p>` : ''}
    </div>
    <p style="font-size:12px;color:#6b7b78;text-align:center;margin-top:14px">Bu e-posta ${esc(APP_NAME)} sistemi tarafından otomatik gönderildi.</p>
  </div></body></html>`;
}
const mailEnabled = () => !!BIRD_KEY;

/* ---------------- şema ---------------- */
async function migrate() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS branch TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS docs (
      coll TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (coll, id));
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      data BYTEA NOT NULL, uploaded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value JSONB NOT NULL);
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const u = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const p = process.env.ADMIN_PASSWORD;
    if (!p) console.warn('Kullanıcı yok ve ADMIN_PASSWORD tanımlı değil: giriş yapılamayacak.');
    else {
      await pool.query('INSERT INTO users (id, username, name, pass, role) VALUES ($1,$2,$3,$4,$5)', [newId(), u, process.env.ADMIN_NAME || 'Yönetici', hashPass(p), 'admin']);
      console.log('İlk yönetici oluşturuldu:', u);
    }
  }
  const docs = await pool.query('SELECT count(*)::int AS n FROM docs');
  if (docs.rows[0].n === 0 && process.env.SEED_JSON) {
    try {
      const seed = JSON.parse(process.env.SEED_JSON); let n = 0;
      for (const [coll, items] of Object.entries(seed)) {
        if (!COLLS.has(coll) || !Array.isArray(items)) continue;
        for (const it of items) { if (!it || !validId(it.id)) continue; const { id, ...data } = it; await pool.query('INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [coll, id, data]); n++; }
      }
      console.log('Başlangıç verisi içe aktarıldı:', n, 'belge');
    } catch (e) { console.error('SEED_JSON okunamadı:', e.message); }
  }
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}
async function getDoc(coll, id) { const { rows } = await pool.query('SELECT data FROM docs WHERE coll=$1 AND id=$2', [coll, id]); return rows[0] ? { id, ...rows[0].data } : null; }
async function getSettings() { return (await getDoc('settings', 'main')) || {}; }
async function putDoc(coll, id, data) {
  const { rows } = await pool.query(`INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING data`, [coll, id, data]);
  return { id, ...rows[0].data };
}

/* ---------------- anlık bildirim (SSE) ---------------- */
const clients = new Set(); // {res, user}
function canSee(user, evt) {
  if (evt.type === 'doc') {
    if (user.role !== 'satici') return true;
    if (evt.coll === 'branches') return true;
    if (evt.coll !== 'requests') return false;
    const owner = (evt.doc && evt.doc.requesterId) || evt.owner;
    return owner === user.id;
  }
  if (evt.type === 'user' || evt.type === 'user-removed') return user.role !== 'satici' || (evt.user && evt.user.id === user.id);
  return true;
}
function broadcast(evt) {
  const msg = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of clients) { if (!canSee(c.user, evt)) continue; try { c.res.write(msg); } catch { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { clients.delete(c); } } }, 25000);

/* ---------------- telefon bildirimi (web push) ---------------- */
async function pushTo(filterSql, params, payload) {
  if (!pushReady) return;
  try {
    const { rows } = await pool.query(`SELECT p.endpoint, p.data FROM push_subs p JOIN users u ON u.id = p.user_id WHERE u.status = 'active' AND ${filterSql}`, params);
    await Promise.all(rows.map(async r => {
      try { await webpush.sendNotification(r.data, JSON.stringify(payload), { TTL: 3600 }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await pool.query('DELETE FROM push_subs WHERE endpoint=$1', [r.endpoint]); }
    }));
  } catch (e) { console.warn('Bildirim hatası', e.message); }
}
const pushStaff = (payload, exceptId) => pushTo("u.role IN ('admin','user') AND u.id <> $1", [exceptId || ''], payload);
const pushUser = (userId, payload) => pushTo('u.id = $1', [userId], payload);

/* ---------------- talep olayları ---------------- */
async function onRequestChange(oldDoc, doc, actor, req) {
  const url = `${baseUrl(req)}/#talepler`;
  if (!oldDoc) {
    pushStaff({ title: 'Yeni ürün talebi', body: `${doc.requesterName || 'Satıcı'}: ${doc.productName || ''} ${doc.productCode ? '(' + doc.productCode + ')' : ''}`, url, tag: 'req-' + doc.id }, actor.id);
    const st = await getSettings();
    const to = st.requestNotifyEmail || st.reportEmail;
    if (to && actor.role === 'satici') {
      sendMail({ to, subject: `Yeni ürün talebi: ${doc.productName} ${doc.productCode ? '(' + doc.productCode + ')' : ''}`,
        html: mailLayout('Yeni ürün talebi geldi', reqTable(doc), { url, label: 'Talepleri aç' }),
        text: `Yeni ürün talebi: ${doc.productName} ${doc.productCode || ''} · ${doc.requesterName} · ${url}` });
    }
    return;
  }
  if (oldDoc.status === doc.status) return;
  const label = REQ_LABEL[doc.status] || doc.status;
  if (doc.requesterId && doc.requesterId !== actor.id) pushUser(doc.requesterId, { title: `Talebiniz: ${label}`, body: `${doc.productName || ''} ${doc.productCode ? '(' + doc.productCode + ')' : ''}`, url, tag: 'req-' + doc.id });
  const texts = {
    talep_edildi: ['Ürün talebiniz iletildi', `Talep ettiğiniz ürün <b>${esc(doc.fromBranch || 'diğer şube')}</b> şubesinden istendi.`],
    yolda: ['Talep ettiğiniz ürün yolda', `Ürün <b>${esc(doc.fromBranch || 'diğer şube')}</b> şubesinden yola çıktı.`],
    geldi: ['Talep ettiğiniz ürün şubeye geldi', 'Ürün şubenize ulaştı, teslim alabilirsiniz.'],
    iptal: ['Ürün talebiniz karşılanamadı', `Talebiniz karşılanamadı.${doc.cancelReason ? ' Açıklama: <b>' + esc(doc.cancelReason) + '</b>' : ''}`],
  };
  const t = texts[doc.status];
  if (t && doc.requesterEmail) {
    const r = await sendMail({ to: doc.requesterEmail, subject: `${t[0]}: ${doc.productName}${doc.productCode ? ' (' + doc.productCode + ')' : ''}`,
      html: mailLayout(t[0], `<p>${t[1]}</p>${reqTable(doc)}`, { url, label: 'Talebi görüntüle' }),
      text: `${t[0]}: ${doc.productName} ${doc.productCode || ''} · ${url}` });
    const entry = { at: new Date().toISOString().slice(0, 16).replace('T', ' '), text: r.ok ? `E-posta gönderildi: ${t[0]} (${doc.requesterEmail})` : `E-posta gönderilemedi (${doc.requesterEmail})`, by: null };
    const cur = await getDoc('requests', doc.id);
    if (cur) { const { id: _i, ...curData } = cur; const saved = await putDoc('requests', doc.id, { ...curData, mailLog: [...(cur.mailLog || []), entry].slice(-30) }); broadcast({ type: 'doc', coll: 'requests', id: doc.id, doc: saved }); }
  }
}
function reqTable(d) {
  const row = (k, v) => v ? `<tr><td style="padding:6px 10px 6px 0;color:#5A6B68;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>` : '';
  return `<table style="border-collapse:collapse;margin-top:10px;font-size:14px">${row('Talep no', d.no)}${row('Ürün', d.productName)}${row('Ürün kodu', d.productCode)}${row('Adet', d.qty)}${row('Talep edilen şube', d.fromBranch)}${row('Kimin için', d.purpose === 'musteri' ? 'Müşteri için' + (d.customerName ? ' · ' + d.customerName : '') : 'Mağaza için')}${row('Talep eden', (d.requesterName || '') + (d.toBranch ? ' · ' + d.toBranch : ''))}${row('Not', d.note)}</table>`;
}

/* ---------------- günlük rapor ---------------- */
let reportBusy = false;
async function maybeDailyReport(force) {
  if (reportBusy) return { ok: false, reason: 'busy' };
  const now = istNow();
  if (!force) {
    if (now.weekday === 'Sun') return; if (now.hour < 8 || (now.hour === 8 && now.minute < 40)) return;
  }
  reportBusy = true;
  try {
    if (!force) {
      const r = await pool.query(`INSERT INTO meta (key, value) VALUES ('lastReport', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE meta.value <> EXCLUDED.value RETURNING key`, [JSON.stringify(now.date)]);
      if (!r.rows.length) return;
    }
    const st = await getSettings();
    const to = st.reportEmail; if (!to) return { ok: false, reason: 'no_recipient' };
    const { rows } = await pool.query("SELECT coll, data FROM docs WHERE coll IN ('tickets','requests')");
    const tickets = rows.filter(r => r.coll === 'tickets').map(r => r.data);
    const reqs = rows.filter(r => r.coll === 'requests').map(r => r.data);
    const act = tickets.filter(t => ACTIVE_T.has(t.status));
    const late = act.filter(t => t.dueAt && t.dueAt < now.date), today = act.filter(t => t.dueAt === now.date);
    const soon = act.filter(t => t.dueAt && dayDiff(now.date, t.dueAt) >= 1 && dayDiff(now.date, t.dueAt) <= 2);
    const waiting = act.filter(t => t.status === 'servisten_geldi' && t.backAt && dayDiff(t.backAt, now.date) >= (Number(st.waitDays) || 3));
    const newReq = reqs.filter(r => r.status === 'yeni');
    const tbl = (title, list, color) => list.length ? `<h3 style="font-size:15px;margin:18px 0 6px;color:${color || '#15201E'}">${esc(title)} (${list.length})</h3><table style="border-collapse:collapse;width:100%;font-size:13px">${list.map(t => `<tr><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8;font-family:monospace">${esc(t.no)}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8">${esc(t.customerName || t.requesterName || '')}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8">${esc(t.productName || '')}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8">${esc(t.firmName || t.fromBranch || '')}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8;white-space:nowrap">${esc(trDate(t.dueAt || t.createdAt))}</td></tr>`).join('')}</table>` : '';
    const html = mailLayout(`Günlük rapor · ${trDate(now.date)}`,
      `<p><b>${act.length}</b> açık kayıt · <b style="color:#C0352A">${late.length}</b> süresi geçen · <b>${today.length}</b> bugün dolan · <b>${soon.length}</b> 2 gün içinde · <b>${waiting.length}</b> mağazada bekleyen · <b>${newReq.length}</b> yeni ürün talebi</p>
      ${tbl('Fatura süresi geçenler', late, '#C0352A')}${tbl('Bugün son gün', today)}${tbl('2 gün içinde dolacaklar', soon)}${tbl('Servisten geldi, müşteri almadı', waiting)}${tbl('Yanıt bekleyen ürün talepleri', newReq)}
      ${!(late.length + today.length + soon.length + waiting.length + newReq.length) ? '<p>Bugün takip edilecek kayıt yok.</p>' : ''}`,
      APP_URL ? { url: APP_URL, label: 'Panoyu aç' } : null);
    return await sendMail({ to, subject: `Günlük rapor ${trDate(now.date)} – ${late.length} gecikmiş, ${today.length} bugün dolan`, html, text: `${act.length} açık kayıt, ${late.length} süresi geçen, ${today.length} bugün dolan, ${newReq.length} yeni talep.` });
  } catch (e) { console.warn('Rapor hatası', e.message); return { ok: false }; } finally { reportBusy = false; }
}

/* ---------------- uygulama ---------------- */
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
  const { rows } = await pool.query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now() AND u.status = 'active'", [tok]);
  if (!rows[0]) return res.status(401).json({ error: 'Oturum süresi doldu' });
  req.user = rows[0];
  maybeDailyReport(false);
  next();
}
const staffOnly = (req, res, next) => (req.user.role === 'satici' ? res.status(403).json({ error: 'Bu bölüm için yetkiniz yok' }) : next());
const isAdmin = (req, res, next) => (req.user.role !== 'admin' ? res.status(403).json({ error: 'Bu işlem için yönetici olmalısınız' }) : next());
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Geçersiz kaynak' }); } catch { return res.status(403).json({ error: 'Geçersiz kaynak' }); } }
  next();
}
app.use('/api', sameOrigin);
app.get('/healthz', (req, res) => res.send('ok'));

/* hız sınırı */
const tries = new Map();
function limited(key, max, windowMs) {
  const t = tries.get(key) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > windowMs) { t.n = 0; t.at = Date.now(); }
  t.n++; tries.set(key, t);
  return t.n > max;
}

/* herkese açık bilgiler */
app.get('/api/public/info', wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT data->>'name' AS name FROM docs WHERE coll='branches' ORDER BY 1");
  res.json({ appName: APP_NAME, branches: rows.map(r => r.name).filter(Boolean), mailEnabled: mailEnabled() });
}));

/* giriş / kayıt */
app.post('/api/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (limited('login:' + req.ip, 10, 15 * 60e3)) return res.status(429).json({ error: 'Çok fazla deneme yapıldı, 15 dakika sonra tekrar deneyin' });
  const id = String(req.body.username || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 OR lower(email) = $1 LIMIT 1', [id]);
  const u = rows[0];
  if (!u || !checkPass(req.body.password || '', u.pass)) return res.status(401).json({ error: 'Kullanıcı adı / e-posta veya şifre hatalı' });
  if (u.status === 'pending') return res.status(403).json({ error: 'E-posta adresiniz henüz doğrulanmadı. Gelen kutunuzdaki bağlantıya tıklayın.', pending: true, email: u.email });
  if (u.status !== 'active') return res.status(403).json({ error: 'Hesabınız devre dışı. Yöneticinize başvurun.' });
  tries.delete('login:' + req.ip);
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
async function sendVerify(req, u, token) {
  const url = `${baseUrl(req)}/api/verify?token=${token}`;
  return sendMail({ to: u.email, subject: `${APP_NAME}: e-posta adresinizi doğrulayın`,
    html: mailLayout(`Hoş geldiniz ${u.name}`, '<p>Hesabınızı etkinleştirmek için e-posta adresinizi doğrulayın. Bağlantı 48 saat geçerlidir.</p>', { url, label: 'E-postamı doğrula' }),
    text: `Hesabınızı etkinleştirmek için bu bağlantıyı açın: ${url}` });
}
app.post('/api/register', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (limited('reg:' + req.ip, 8, 60 * 60e3)) return res.status(429).json({ error: 'Çok fazla kayıt denemesi, bir saat sonra tekrar deneyin' });
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const branch = String(req.body.branch || '').trim().slice(0, 80);
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  if (name.length < 2) return res.status(400).json({ error: 'Ad soyad girin' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
  if (password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  if (!branch) return res.status(400).json({ error: 'Çalıştığınız şubeyi seçin' });
  const ex = await pool.query('SELECT id, status FROM users WHERE lower(email) = $1 OR username = $1', [email]);
  if (ex.rows[0]) return res.status(400).json({ error: ex.rows[0].status === 'pending' ? 'Bu e-posta ile kayıt var, doğrulama bekleniyor. Aşağıdan doğrulama e-postasını tekrar isteyebilirsiniz.' : 'Bu e-posta adresiyle zaten bir hesap var. Giriş yapın veya şifrenizi sıfırlayın.' });
  const id = newId(); const token = crypto.randomBytes(24).toString('hex');
  await pool.query(`INSERT INTO users (id, username, name, pass, role, email, status, branch, phone, verify_token, verify_expires) VALUES ($1,$2,$3,$4,'satici',$2,'pending',$5,$6,$7, now() + interval '48 hours')`, [id, email, name, hashPass(password), branch, phone, token]);
  const r = await sendVerify(req, { name, email }, token);
  broadcast({ type: 'user', user: { id, username: email, name, role: 'satici', email, branch, phone, status: 'pending' } });
  pushStaff({ title: 'Yeni kayıt', body: `${name} (${branch}) kayıt oldu`, url: `${baseUrl(req)}/#tanimlar` });
  res.json({ ok: true, mailSent: r.ok });
}));
app.post('/api/resend-verification', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (limited('resend:' + req.ip, 5, 60 * 60e3)) return res.status(429).json({ error: 'Çok fazla istek, daha sonra tekrar deneyin' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query("SELECT * FROM users WHERE lower(email) = $1 AND status = 'pending'", [email]);
  let sent = false;
  if (rows[0]) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query("UPDATE users SET verify_token = $1, verify_expires = now() + interval '48 hours' WHERE id = $2", [token, rows[0].id]);
    sent = (await sendVerify(req, rows[0], token)).ok;
  }
  res.json({ ok: true, mailSent: sent });
}));
app.get('/api/verify', wrap(async (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{48}$/.test(token)) return res.redirect('/?verified=0');
  const { rows } = await pool.query("UPDATE users SET email_verified = true, status = 'active', verify_token = NULL WHERE verify_token = $1 AND verify_expires > now() RETURNING id, username, name, role, email, branch, phone, status", [token]);
  if (!rows[0]) return res.redirect('/?verified=0');
  broadcast({ type: 'user', user: rows[0] });
  res.redirect('/?verified=1');
}));
app.post('/api/forgot', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (limited('forgot:' + req.ip, 5, 60 * 60e3)) return res.status(429).json({ error: 'Çok fazla istek, daha sonra tekrar deneyin' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query("SELECT * FROM users WHERE lower(email) = $1 AND status = 'active'", [email]);
  if (rows[0]) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query("UPDATE users SET reset_token = $1, reset_expires = now() + interval '1 hour' WHERE id = $2", [token, rows[0].id]);
    const url = `${baseUrl(req)}/?reset=${token}`;
    await sendMail({ to: rows[0].email, subject: `${APP_NAME}: şifre sıfırlama`, html: mailLayout('Şifre sıfırlama', '<p>Şifrenizi sıfırlamak için aşağıdaki düğmeye tıklayın. Bağlantı 1 saat geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı yok sayın.</p>', { url, label: 'Yeni şifre belirle' }), text: `Şifre sıfırlama: ${url}` });
  }
  res.json({ ok: true });
}));
app.post('/api/reset', express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const token = String(req.body.token || ''); const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  const { rows } = await pool.query('UPDATE users SET pass = $1, reset_token = NULL WHERE reset_token = $2 AND reset_expires > now() RETURNING id', [hashPass(pw), token]);
  if (!rows[0]) return res.status(400).json({ error: 'Bağlantının süresi dolmuş. Şifre sıfırlamayı yeniden isteyin.' });
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
  res.json({ ok: true });
}));
app.post('/api/me/password', express.json({ limit: '10kb' }), wrap(auth), wrap(async (req, res) => {
  const { current, next: nw } = req.body || {};
  if (!checkPass(current || '', req.user.pass)) return res.status(400).json({ error: 'Mevcut şifre hatalı' });
  if (!nw || String(nw).length < 6) return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı' });
  await pool.query('UPDATE users SET pass = $1 WHERE id = $2', [hashPass(nw), req.user.id]);
  res.json({ ok: true });
}));
app.patch('/api/me', express.json({ limit: '10kb' }), wrap(auth), wrap(async (req, res) => {
  const name = String(req.body.name || req.user.name).trim().slice(0, 80) || req.user.name;
  const phone = String(req.body.phone ?? req.user.phone ?? '').trim().slice(0, 30);
  const branch = String(req.body.branch ?? req.user.branch ?? '').trim().slice(0, 80);
  let email = req.user.email;
  if (req.body.email != null && req.user.role !== 'satici') {
    const e = String(req.body.email).trim().toLowerCase();
    if (e && !validEmail(e)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
    email = e || null;
  }
  try { await pool.query('UPDATE users SET name=$1, phone=$2, branch=$3, email=$4 WHERE id=$5', [name, phone, branch, email, req.user.id]); }
  catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Bu e-posta başka bir hesapta kayıtlı' }); throw e; }
  const u = { ...req.user, name, phone, branch, email };
  broadcast({ type: 'user', user: publicUser(u) });
  res.json(publicUser(u));
}));

/* tüm veriler */
app.get('/api/bootstrap', wrap(auth), wrap(async (req, res) => {
  const seller = req.user.role === 'satici';
  const [docs, users] = await Promise.all([
    seller ? pool.query("SELECT coll, id, data FROM docs WHERE coll = 'branches' OR (coll = 'requests' AND data->>'requesterId' = $1)", [req.user.id]) : pool.query('SELECT coll, id, data FROM docs'),
    seller ? Promise.resolve({ rows: [publicUser(req.user)] }) : pool.query('SELECT id, username, name, role, email, branch, phone, status FROM users ORDER BY name'),
  ]);
  const data = {}; for (const c of COLLS) data[c] = [];
  for (const r of docs.rows) data[r.coll].push({ id: r.id, ...r.data });
  if (seller) { const st = await getSettings(); data.settings = [{ id: 'main', storeName: st.storeName || '', holidays: st.holidays || [] }]; }
  res.json({ me: publicUser(req.user), users: users.rows, data, push: pushReady ? VAPID_PUBLIC : null, mailEnabled: mailEnabled() });
}));

app.get('/api/events', wrap(auth), (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  const c = { res, user: { id: req.user.id, role: req.user.role } };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});

/* belgeler */
function checkDoc(req, res) {
  const { coll, id } = req.params;
  if (!COLLS.has(coll) || !validId(id)) { res.status(400).json({ error: 'Geçersiz kayıt yolu' }); return false; }
  if (req.user.role === 'viewer') { res.status(403).json({ error: 'Görüntüleme yetkiniz var, değişiklik yapamazsınız' }); return false; }
  if (req.user.role === 'satici' && coll !== 'requests') { res.status(403).json({ error: 'Bu bölüm için yetkiniz yok' }); return false; }
  return true;
}
function sellerSanitize(body, old, user) {
  const out = {};
  for (const [k, v] of Object.entries(body)) if (SELLER_FIELDS.has(k)) out[k] = v;
  if (old) {
    if (old.requesterId !== user.id) return { error: 'Sadece kendi taleplerinizi değiştirebilirsiniz' };
    if (old.status !== 'yeni') return { error: 'İşleme alınmış talep değiştirilemez' };
    if ('status' in out && out.status !== 'yeni' && out.status !== 'iptal') return { error: 'Talep durumunu değiştiremezsiniz' };
  } else {
    out.status = 'yeni';
  }
  return { data: out };
}
async function writeDoc(req, res, mode) {
  if (!checkDoc(req, res)) return;
  const { coll, id } = req.params;
  let body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Geçersiz veri' });
  delete body.id;
  const old = await getDoc(coll, id);
  if (mode === 'patch' && !old) return res.status(404).json({ error: 'Kayıt bulunamadı' });
  if (req.user.role === 'satici') {
    const s = sellerSanitize(body, old, req.user);
    if (s.error) return res.status(403).json({ error: s.error });
    body = s.data;
  }
  let data;
  if (mode === 'put') data = { ...body };
  else { data = { ...old, ...body }; delete data.id; }
  if (coll === 'requests') {
    if (old) { data.requesterId = old.requesterId; data.requesterName = old.requesterName; data.requesterEmail = old.requesterEmail; data.toBranch = old.toBranch; data.no = old.no; data.createdAt = old.createdAt; }
    else {
      const self = req.user.role === 'satici' || !data.requesterId;
      if (self) { data.requesterId = req.user.id; data.requesterName = req.user.name; data.requesterEmail = req.user.email || null; data.toBranch = req.user.branch || data.toBranch || null; }
      data.createdAt = data.createdAt || new Date().toISOString();
      if (!data.no) data.no = 'TLP-' + istNow().date.slice(2).replace(/-/g, '') + '-' + id.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
    }
    if (data.status === 'talep_edildi' && !data.requestedAt) data.requestedAt = new Date().toISOString();
  }
  const doc = await putDoc(coll, id, data);
  broadcast({ type: 'doc', coll, id, doc });
  res.json(doc);
  if (coll === 'requests') onRequestChange(old, doc, req.user, req).catch(e => console.warn(e.message));
  if (coll === 'tickets' && old && old.status !== doc.status && doc.status === 'servisten_geldi')
    pushStaff({ title: 'Ürün servisten geldi', body: `${doc.no} · ${doc.customerName || ''} · ${doc.productName || ''}`, url: `${baseUrl(req)}/?k=${id}`, tag: 'tk-' + id }, req.user.id);
}
const jsonBody = express.json({ limit: '1mb' });
app.put('/api/docs/:coll/:id', jsonBody, wrap(auth), wrap((req, res) => writeDoc(req, res, 'put')));
app.patch('/api/docs/:coll/:id', jsonBody, wrap(auth), wrap((req, res) => writeDoc(req, res, 'patch')));
app.delete('/api/docs/:coll/:id', wrap(auth), wrap(async (req, res) => {
  if (!checkDoc(req, res)) return;
  const { coll, id } = req.params;
  const old = await getDoc(coll, id);
  if (req.user.role === 'satici' && old && (old.requesterId !== req.user.id || old.status !== 'yeni')) return res.status(403).json({ error: 'Sadece işleme alınmamış kendi taleplerinizi silebilirsiniz' });
  await pool.query('DELETE FROM docs WHERE coll = $1 AND id = $2', [coll, id]);
  broadcast({ type: 'doc', coll, id, doc: null, owner: old && old.requesterId });
  res.json({ ok: true });
}));

/* dosyalar */
app.post('/api/files', wrap(auth), staffOnly, (req, res, next) => (req.user.role === 'viewer' ? res.status(403).json({ error: 'Yetkiniz yok' }) : next()), express.raw({ type: () => true, limit: MAX_FILE }), wrap(async (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!FILE_TYPES.has(type)) return res.status(415).json({ error: 'Yalnızca JPG, PNG, WEBP, GIF ve PDF yüklenebilir' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Dosya boş' });
  let name = 'dosya'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'dosya')).slice(0, 200); } catch {}
  const id = newId(24);
  await pool.query('INSERT INTO files (id, name, type, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, type, req.body.length, req.body, req.user.id]);
  res.json({ id, size: req.body.length, type, name });
}));
app.get('/api/files/:id', wrap(auth), staffOnly, wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).end();
  const { rows } = await pool.query('SELECT name, type, data FROM files WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].type);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.send(rows[0].data);
}));
app.delete('/api/files/:id', wrap(auth), staffOnly, wrap(async (req, res) => {
  if (!validId(req.params.id) || req.user.role === 'viewer') return res.status(400).end();
  await pool.query('DELETE FROM files WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* kullanıcılar (yönetici) */
app.get('/api/users', wrap(auth), staffOnly, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, name, role, email, branch, phone, status, created_at FROM users ORDER BY name');
  res.json(rows);
}));
app.post('/api/users', express.json({ limit: '10kb' }), wrap(auth), isAdmin, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const role = ROLES.has(req.body.role) ? req.body.role : 'user';
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const branch = String(req.body.branch || '').trim() || null;
  if (!/^[a-z0-9._@+-]{3,64}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-64 karakter olmalı; harf, rakam, nokta, tire kullanın' });
  if (!name) return res.status(400).json({ error: 'Ad soyad girin' });
  if (password.length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
  if (email && !validEmail(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
  try {
    const id = newId();
    await pool.query("INSERT INTO users (id, username, name, pass, role, email, email_verified, status, branch) VALUES ($1,$2,$3,$4,$5,$6,true,'active',$7)", [id, username, name, hashPass(password), role, email, branch]);
    const u = { id, username, name, role, email, branch, status: 'active' };
    broadcast({ type: 'user', user: u });
    res.json(u);
  } catch (e) { if (e.code === '23505') return res.status(400).json({ error: 'Bu kullanıcı adı veya e-posta zaten var' }); throw e; }
}));
app.patch('/api/users/:id', express.json({ limit: '10kb' }), wrap(auth), isAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  const name = req.body.name != null ? String(req.body.name).trim() || u.name : u.name;
  const role = ROLES.has(req.body.role) ? req.body.role : u.role;
  const status = ['active', 'pending', 'disabled'].includes(req.body.status) ? req.body.status : u.status;
  const branch = req.body.branch != null ? String(req.body.branch).trim() || null : u.branch;
  if (u.id === req.user.id && (role !== 'admin' || status !== 'active')) return res.status(400).json({ error: 'Kendi yönetici hesabınızı kısıtlayamazsınız' });
  let pass = u.pass;
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });
    pass = hashPass(req.body.password);
  }
  if (req.body.password || status !== 'active' || role !== u.role) await pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  await pool.query('UPDATE users SET name=$1, role=$2, pass=$3, status=$4, branch=$5, email_verified = email_verified OR $6 WHERE id=$7', [name, role, pass, status, branch, status === 'active' && u.status === 'pending', u.id]);
  const out = publicUser({ ...u, name, role, status, branch });
  broadcast({ type: 'user', user: out });
  res.json(out);
}));
app.delete('/api/users/:id', wrap(auth), isAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  broadcast({ type: 'user-removed', id: req.params.id });
  res.json({ ok: true });
}));

/* bildirim aboneliği */
app.post('/api/push/subscribe', express.json({ limit: '10kb' }), wrap(auth), wrap(async (req, res) => {
  const s = req.body && req.body.subscription;
  if (!pushReady) return res.status(400).json({ error: 'Bildirimler sunucuda etkin değil' });
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) return res.status(400).json({ error: 'Geçersiz abonelik' });
  await pool.query('INSERT INTO push_subs (endpoint, user_id, data) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, data = EXCLUDED.data', [s.endpoint, req.user.id, s]);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', express.json({ limit: '10kb' }), wrap(auth), wrap(async (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep) await pool.query('DELETE FROM push_subs WHERE endpoint = $1 AND user_id = $2', [ep, req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/push/test', wrap(auth), wrap(async (req, res) => {
  await pushUser(req.user.id, { title: APP_NAME, body: 'Bildirimler bu cihazda çalışıyor.', url: baseUrl(req) + '/' });
  res.json({ ok: true });
}));

/* rapor (yönetici) */
app.post('/api/report/send', wrap(auth), isAdmin, wrap(async (req, res) => {
  const r = await maybeDailyReport(true);
  res.json(r || { ok: false });
}));
app.post('/api/mail/test', express.json({ limit: '10kb' }), wrap(auth), isAdmin, wrap(async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!validEmail(to)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin' });
  const r = await sendMail({ to, subject: `${APP_NAME}: deneme e-postası`, html: mailLayout('Deneme e-postası', '<p>E-posta gönderimi çalışıyor.</p>'), text: 'E-posta gönderimi çalışıyor.' });
  res.json(r);
}));

/* müşteri takip sayfası */
async function ticketByToken(token) {
  if (!/^[a-z0-9]{16,40}$/.test(token)) return null;
  const { rows } = await pool.query("SELECT id, data FROM docs WHERE coll = 'tickets' AND data->>'publicToken' = $1 LIMIT 1", [token]);
  return rows[0] ? { id: rows[0].id, ...rows[0].data } : null;
}
const STEPS = [['teslim_alindi', 'Ürün teslim alındı', 'openedAt'], ['servise_gonderildi', 'Servise gönderildi', 'sentAt'], ['serviste', 'Serviste', null], ['servisten_geldi', 'Servisten geldi, teslim alabilirsiniz', 'backAt'], ['musteriye_teslim', 'Müşteriye teslim edildi', 'deliveredAt']];
const ORDER = { teslim_alindi: 0, acik: 0, servise_gonderildi: 1, serviste: 2, islemde: 2, parca: 2, servisten_geldi: 3, musteriye_teslim: 4, fatura_talep: 4, faturalandi: 4, kapandi: 4 };
const RESULT = { tamir_edildi: 'Onarıldı', degisim: 'Değişim yapıldı', iade: 'İade', tamir_edilemez: 'Onarılamadı', ucretli: 'Ücretli onarım' };
app.get('/takip/:token', wrap(async (req, res) => {
  const t = await ticketByToken(req.params.token);
  const st = await getSettings();
  const store = st.storeName || APP_NAME;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!t) return res.status(404).send(publicPage(store, '<h1>Kayıt bulunamadı</h1><p>Bağlantı hatalı ya da kayıt kaldırılmış olabilir. Lütfen mağazamızla iletişime geçin.</p>', st));
  const idx = ORDER[t.status] ?? 0;
  const first = String(t.customerName || '').split(' ')[0];
  const steps = STEPS.map(([k, label, f], i) => `<li class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"><b>${esc(label)}</b>${f && t[f] ? `<span>${esc(trDate(t[f]))}</span>` : ''}</li>`).join('');
  const q = t.quote || {};
  let quote = '';
  if (q.amount) {
    if (q.status === 'bekliyor') quote = `<div class="box warn"><h2>Onarım bedeli onayınız bekleniyor</h2><p>Servisin bildirdiği onarım bedeli: <b>${esc(Number(q.amount).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' }))}</b>${q.note ? '<br>' + esc(q.note) : ''}</p>
      <form method="post" action="/takip/${esc(req.params.token)}/teklif"><button name="karar" value="onay" class="ok">Onaylıyorum</button><button name="karar" value="red" class="no">Onaylamıyorum</button></form></div>`;
    else quote = `<div class="box"><p>Onarım bedeli (${esc(Number(q.amount).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' }))}): <b>${q.status === 'onaylandi' ? 'onayladınız' : 'onaylamadınız'}</b>${q.decidedAt ? ' · ' + esc(trDate(q.decidedAt)) : ''}</p></div>`;
  }
  const body = `<p class="hi">Merhaba ${esc(first)},</p><h1>${esc(t.productName || 'Ürününüz')}</h1><p class="no">Kayıt no: <b>${esc(t.no)}</b></p>
    ${req.query.ok ? `<div class="box okb">${req.query.ok === 'onay' ? 'Onayınız alındı, teşekkür ederiz. Onarım başlatılacak.' : 'Kararınız kaydedildi. Mağazamız sizinle iletişime geçecek.'}</div>` : ''}
    ${quote}<ol class="steps">${steps}</ol>
    ${t.serviceResult && RESULT[t.serviceResult] ? `<div class="box"><p>Servis sonucu: <b>${esc(RESULT[t.serviceResult])}</b></p></div>` : ''}`;
  res.send(publicPage(store, body, st));
}));
app.post('/takip/:token/teklif', express.urlencoded({ extended: false, limit: '2kb' }), wrap(async (req, res) => {
  if (limited('quote:' + req.ip, 20, 60 * 60e3)) return res.status(429).send('Çok fazla istek');
  const t = await ticketByToken(req.params.token);
  if (!t || !t.quote || t.quote.status !== 'bekliyor') return res.redirect(`/takip/${encodeURIComponent(req.params.token)}`);
  const ok = req.body.karar === 'onay';
  const now = new Date();
  const stamp = now.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16);
  const { id, ...rest } = t;
  const data = { ...rest, quote: { ...t.quote, status: ok ? 'onaylandi' : 'reddedildi', decidedAt: now.toISOString().slice(0, 10), via: 'takip' }, updatedAt: now.toISOString(),
    log: [...(t.log || []), { at: stamp, text: ok ? 'Müşteri onarım bedelini onayladı (takip sayfası)' : 'Müşteri onarım bedelini onaylamadı (takip sayfası)', by: null }].slice(-80) };
  const doc = await putDoc('tickets', id, data);
  broadcast({ type: 'doc', coll: 'tickets', id, doc });
  pushStaff({ title: ok ? 'Onarım onaylandı' : 'Onarım reddedildi', body: `${t.no} · ${t.customerName || ''} · ${t.productName || ''}`, url: `${baseUrl(req)}/?k=${id}`, tag: 'tk-' + id });
  res.redirect(`/takip/${encodeURIComponent(req.params.token)}?ok=${ok ? 'onay' : 'red'}`);
}));
function publicPage(store, body, st) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ürün takibi · ${esc(store)}</title><meta name="robots" content="noindex">
  <link rel="icon" href="/icon.svg"><style>
  :root{--bg:#EEF2F1;--fg:#15201E;--muted:#5A6B68;--line:#D3DDDB;--card:#fff;--acc:#0D6B68;--gold:#C9962B;--ok:#2E7D3A;--bad:#C0352A;--warn:#FBEBD2}
  @media (prefers-color-scheme:dark){:root{--bg:#0E1514;--fg:#E3ECEA;--muted:#97A9A6;--line:#2A3A38;--card:#151F1E;--acc:#3DB5AE;--ok:#62C26D;--bad:#F06C5F;--warn:#3A2B12}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Segoe UI",system-ui,sans-serif}
  header{background:#0F2E2C;color:#fff;padding:16px max(16px,env(safe-area-inset-left));display:flex;gap:10px;align-items:center;font-weight:800}
  header img{width:34px;height:34px}main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
  h1{font-size:1.5rem;margin:.1em 0}.hi{color:var(--muted);margin:0}.no{color:var(--muted);margin:.2em 0 1em}
  .steps{list-style:none;padding:0;margin:18px 0;border-left:3px solid var(--line)}.steps li{position:relative;padding:6px 0 14px 20px;color:var(--muted)}
  .steps li::before{content:"";position:absolute;left:-9px;top:9px;width:15px;height:15px;border-radius:50%;background:var(--bg);border:3px solid var(--line)}
  .steps li.done{color:var(--fg)}.steps li.done::before{background:var(--acc);border-color:var(--acc)}
  .steps li.cur{color:var(--fg)}.steps li.cur::before{background:var(--gold);border-color:var(--gold);box-shadow:0 0 0 4px rgba(201,150,43,.25)}
  .steps b{display:block}.steps span{font-size:.85rem;color:var(--muted)}
  .box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:12px 0}.box.warn{background:var(--warn);border-color:transparent}.box.okb{border-color:var(--ok)}
  .box h2{font-size:1.05rem;margin:0 0 6px}form{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
  button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:11px 18px;cursor:pointer}button.ok{background:var(--ok);color:#fff}button.no{background:var(--card);color:var(--bad);border:1px solid var(--bad)}
  footer{color:var(--muted);font-size:.85rem;margin-top:24px}</style></head>
  <body><header><img src="/icon.svg" alt=""><span>${esc(store)}</span></header><main>${body}
  <footer>${st.storePhone ? 'Bilgi için: ' + esc(st.storePhone) : ''}</footer></main></body></html>`;
}

/* sayfa */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0, setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/'); } }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Dosya çok büyük (en fazla 15 MB)' });
  console.error(err);
  res.status(500).json({ error: 'Sunucu hatası' });
});

migrate().then(() => {
  app.listen(PORT, () => console.log(`${APP_NAME} çalışıyor, port ${PORT} · e-posta: ${mailEnabled() ? 'açık' : 'kapalı'} · bildirim: ${pushReady ? 'açık' : 'kapalı'}`));
}).catch(e => { console.error('Veritabanı hazırlanamadı:', e); process.exit(1); });
