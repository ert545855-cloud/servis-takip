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
 *   OLD_DATABASE_URL / OLD_DB_SCHEMA   Veritabanı boşken verileri bu eski veritabanından taşır
 *   PORT             Dinlenecek port
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
let webpush = null;
let XLSX = null;
try { XLSX = require('xlsx'); } catch { /* isteğe bağlı */ }
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

const COLLS = new Set(['tickets', 'firms', 'customers', 'categories', 'products', 'settings', 'requests', 'branches', 'shipments', 'announcements']);
const STAFF_ROLES = new Set(['admin', 'user']);
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_FILE = 15 * 1024 * 1024;
const SESSION_DAYS = 30;
const ROLES = new Set(['admin', 'user', 'satici', 'viewer']);
const ACTIVE_T = new Set(['teslim_alindi', 'servise_gonderildi', 'serviste', 'servisten_geldi', 'musteriye_teslim', 'fatura_talep', 'acik', 'islemde', 'parca']);
const REQ_LABEL = { yeni: 'Yeni talep', talep_edildi: 'Talep edildi', yolda: 'Yolda', geldi: 'Şubeye geldi', tamamlandi: 'Tamamlandı', iptal: 'Karşılanamadı / iptal' };
const SELLER_FIELDS = new Set(['productName', 'productCode', 'barcode', 'qty', 'fromBranch', 'purpose', 'customerName', 'customerPhone', 'note', 'neededBy', 'priority', 'updatedAt', 'log', 'comments', 'status']);

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
async function sendMail({ to, subject, html, text, attachments }) {
  if (!BIRD_KEY || !to) return { ok: false, reason: 'no_key' };
  const region = (BIRD_KEY.match(/^bk_([a-z]{2}\d+)_/) || [])[1] || 'us1';
  try {
    const r = await fetch(`https://${region}.platform.bird.com/v1/email/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BIRD_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { email: MAIL_FROM, name: MAIL_FROM_NAME }, to: [to], subject, html, text, category: 'transactional', track_opens: false, track_clicks: false, ...(attachments ? { attachments } : {}) }),
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
    CREATE TABLE IF NOT EXISTS trash (
      coll TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, deleted_by TEXT, deleted_by_name TEXT,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (coll, id));
  `);
  await migrateFromOld();
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
  await purgeTrash();
}
/* çöp kutusu: 30 günden eski silinenler kalıcı olarak silinir */
const TRASH_DAYS = 30;
function ticketFileIds(t) { return [...new Set([...(t.attachments || []).map(a => a && a.id), t.signature && t.signature.fileId, t.warrantyDocId].filter(validIdS))]; }
function validIdS(x) { return typeof x === 'string' && /^[A-Za-z0-9_\-]{1,120}$/.test(x); }
async function dropFiles(ids) { if (ids.length) await pool.query('DELETE FROM files WHERE id = ANY($1::text[])', [ids]); }
async function purgeTrash() {
  try {
    const { rows } = await pool.query(`DELETE FROM trash WHERE deleted_at < now() - interval '${TRASH_DAYS} days' RETURNING coll, data`);
    const ids = rows.filter(r => r.coll === 'tickets').flatMap(r => ticketFileIds(r.data));
    await dropFiles(ids);
    if (rows.length) console.log('Çöp kutusundan kalıcı silindi:', rows.length);
  } catch (e) { console.warn('Çöp kutusu temizlenemedi', e.message); }
}
async function migrateFromOld() {
  const oldUrl = process.env.OLD_DATABASE_URL;
  if (!oldUrl) return;
  const cnt = await pool.query('SELECT count(*)::int AS n FROM docs');
  if (cnt.rows[0].n > 0) return;
  const oldSchema = /^[a-z_][a-z0-9_]{0,40}$/.test(process.env.OLD_DB_SCHEMA || '') ? process.env.OLD_DB_SCHEMA : 'servis';
  const old = new Pool({ connectionString: oldUrl, ssl: /localhost|127\.0\.0\.1/.test(oldUrl) ? false : { rejectUnauthorized: false }, max: 2 });
  try {
    const q = t => old.query(`SELECT * FROM ${oldSchema}.${t}`);
    const [docs, users, files] = await Promise.all([q('docs'), q('users'), q('files')]);
    await pool.query('DELETE FROM users');
    for (const u of users.rows) await pool.query('INSERT INTO users (id, username, name, pass, role, created_at, email, email_verified, status, branch, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING', [u.id, u.username, u.name, u.pass, u.role, u.created_at, u.email || null, !!u.email_verified, u.status || 'active', u.branch || null, u.phone || null]);
    for (const d of docs.rows) await pool.query('INSERT INTO docs (coll, id, data, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [d.coll, d.id, d.data, d.updated_at]);
    for (const f of files.rows) await pool.query('INSERT INTO files (id, name, type, size, data, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [f.id, f.name, f.type, f.size, f.data, f.uploaded_by, f.created_at]);
    console.log(`Eski veritabanından taşındı: ${docs.rows.length} belge, ${users.rows.length} kullanıcı, ${files.rows.length} dosya`);
  } catch (e) { console.error('Eski veritabanından taşıma başarısız:', e.message); } finally { await old.end().catch(() => {}); }
}
async function getDoc(coll, id) { const { rows } = await pool.query('SELECT data FROM docs WHERE coll=$1 AND id=$2', [coll, id]); return rows[0] ? { id, ...rows[0].data } : null; }
async function getSettings() { return (await getDoc('settings', 'main')) || {}; }
async function putDoc(coll, id, data) {
  const { rows } = await pool.query(`INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING data`, [coll, id, data]);
  return { id, ...rows[0].data };
}

/* ---------------- duyuru görünürlüğü ---------------- */
function annVisible(user, a) {
  if (!a) return false;
  if (user.role !== 'satici') return true;
  const aud = a.audience || 'all';
  if (aud === 'all' || aud === 'satici') return true;
  if (aud.startsWith('branch:')) return (user.branch || '') === aud.slice(7);
  return false;
}
function annTargetsSql(a) {
  const aud = (a && a.audience) || 'all';
  if (aud === 'staff') return ["u.role IN ('admin','user','viewer')", []];
  if (aud === 'satici') return ["u.role = 'satici'", []];
  if (aud.startsWith('branch:')) return ['u.branch = $1', [aud.slice(7)]];
  return ['true', []];
}

/* ---------------- anlık bildirim (SSE) ---------------- */
const clients = new Set(); // {res, user}
function canSee(user, evt) {
  if (evt.type === 'doc') {
    if (user.role !== 'satici') return true;
    if (evt.coll === 'branches') return true;
    if (evt.coll === 'announcements') return evt.doc ? annVisible(user, evt.doc) : true;
    if (evt.coll !== 'requests') return false;
    const owner = (evt.doc && evt.doc.requesterId) || evt.owner;
    return owner === user.id;
  }
  if (evt.type === 'user' || evt.type === 'user-removed') return user.role !== 'satici' || (evt.user && evt.user.id === user.id);
  if (evt.type === 'reload') return user.role !== 'satici';
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
let reportBusy = false, lastReportDay = null;
async function maybeDailyReport(force) {
  const now = istNow();
  if (!force) {
    if (lastReportDay === now.date || reportBusy) return;
    if (now.weekday === 'Sun') return; if (now.hour < 8 || (now.hour === 8 && now.minute < 40)) return;
  } else {
    for (let i = 0; reportBusy && i < 100; i++) await new Promise(r => setTimeout(r, 100));
    if (reportBusy) return { ok: false, reason: 'busy' };
  }
  reportBusy = true;
  try {
    if (!force) {
      const r = await pool.query(`INSERT INTO meta (key, value) VALUES ('lastReport', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE meta.value <> EXCLUDED.value RETURNING key`, [JSON.stringify(now.date)]);
      lastReportDay = now.date;
      if (!r.rows.length) return;
    }
    const st = await getSettings();
    const to = st.reportEmail;
    purgeTrash();
    const { rows } = await pool.query("SELECT coll, data FROM docs WHERE coll IN ('tickets','requests')");
    const tickets = rows.filter(r => r.coll === 'tickets').map(r => r.data);
    const reqs = rows.filter(r => r.coll === 'requests').map(r => r.data);
    const act = tickets.filter(t => ACTIVE_T.has(t.status));
    const late = act.filter(t => t.dueAt && t.dueAt < now.date), today = act.filter(t => t.dueAt === now.date);
    const soon = act.filter(t => t.dueAt && dayDiff(now.date, t.dueAt) >= 1 && dayDiff(now.date, t.dueAt) <= 2);
    const waiting = act.filter(t => t.status === 'servisten_geldi' && t.backAt && dayDiff(t.backAt, now.date) >= (Number(st.waitDays) || 3));
    const newReq = reqs.filter(r => r.status === 'yeni');
    const notify = act.filter(t => t.status === 'servisten_geldi' && !(t.sms || []).some(x => x.stage === 'servisten_geldi'));
    const warnCal = Math.ceil((Number(st.serviceWarnDays) || 15) * 7 / 5);
    const longSvc = act.filter(t => ['servise_gonderildi', 'serviste'].includes(t.status) && t.sentAt && dayDiff(t.sentAt, now.date) >= warnCal);
    const loans = tickets.filter(t => t.loaner && t.loaner.name && !t.loaner.backAt);
    const exch = tickets.filter(t => ['degisim', 'iade'].includes(t.serviceResult) && t.exchange && !t.exchange.doneAt && !['kapandi'].includes(t.status));
    if (!force) {
      const parts = [late.length && `${late.length} gecikmiş`, waiting.length && `${waiting.length} mağazada bekleyen`, notify.length && `${notify.length} müşteriye haber verilecek`, longSvc.length && `${longSvc.length} serviste uzun kalan`, loans.length && `${loans.length} ödünç ürün dışarıda`, newReq.length && `${newReq.length} yeni talep`].filter(Boolean);
      if (parts.length) pushStaff({ title: 'Günaydın · bugünün hatırlatmaları', body: parts.join(' · '), url: (APP_URL || '') + '/#pano', tag: 'daily' });
    }
    if (!to) return { ok: false, reason: 'no_recipient' };
    const tbl = (title, list, color) => list.length ? `<h3 style="font-size:15px;margin:18px 0 6px;color:${color || '#15201E'}">${esc(title)} (${list.length})</h3><table style="border-collapse:collapse;width:100%;font-size:13px">${list.map(t => `<tr><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8;font-family:monospace">${esc(t.no)}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8">${esc(t.customerName || t.requesterName || '')}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8">${esc(t.productName || '')}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8">${esc(t.firmName || t.fromBranch || '')}</td><td style="padding:5px 6px;border-bottom:1px solid #E3EAE8;white-space:nowrap">${esc(trDate(t.dueAt || t.createdAt))}</td></tr>`).join('')}</table>` : '';
    const html = mailLayout(`Günlük rapor · ${trDate(now.date)}`,
      `<p><b>${act.length}</b> açık kayıt · <b style="color:#C0352A">${late.length}</b> süresi geçen · <b>${today.length}</b> bugün dolan · <b>${soon.length}</b> 2 gün içinde · <b>${waiting.length}</b> mağazada bekleyen · <b>${newReq.length}</b> yeni ürün talebi</p>
      ${tbl('Fatura süresi geçenler', late, '#C0352A')}${tbl('Bugün son gün', today)}${tbl('2 gün içinde dolacaklar', soon)}${tbl('Servisten geldi, müşteri almadı', waiting)}${tbl('Servisten geldi, müşteriye haber verilmedi', notify, '#A86300')}${tbl('Serviste uzun kalanlar', longSvc, '#A86300')}${tbl('Ödünç ürünü müşteride olanlar', loans)}${tbl('Değişim / iade süreci açık', exch)}${tbl('Yanıt bekleyen ürün talepleri', newReq)}
      ${!(late.length + today.length + soon.length + waiting.length + newReq.length) ? '<p>Bugün takip edilecek kayıt yok.</p>' : ''}`,
      APP_URL ? { url: APP_URL, label: 'Panoyu aç' } : null);
    sendBackup(st.backupEmail || to).catch(e => console.warn('Yedek hatası', e.message));
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
    seller ? pool.query("SELECT coll, id, data FROM docs WHERE coll IN ('branches','announcements') OR (coll = 'requests' AND data->>'requesterId' = $1)", [req.user.id]) : pool.query('SELECT coll, id, data FROM docs'),
    seller ? Promise.resolve({ rows: [publicUser(req.user)] }) : pool.query('SELECT id, username, name, role, email, branch, phone, status FROM users ORDER BY name'),
  ]);
  const data = {}; for (const c of COLLS) data[c] = [];
  for (const r of docs.rows) { if (seller && r.coll === 'announcements' && !annVisible(req.user, r.data)) continue; data[r.coll].push({ id: r.id, ...r.data }); }
  if (seller) { const st = await getSettings(); data.settings = [{ id: 'main', storeName: st.storeName || '', holidays: st.holidays || [] }]; }
  res.json({ me: publicUser(req.user), users: users.rows, data, push: pushReady ? VAPID_PUBLIC : null, mailEnabled: mailEnabled() });
}));

app.get('/api/events', wrap(auth), (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  const c = { res, user: { id: req.user.id, role: req.user.role, branch: req.user.branch || '' } };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});

/* belgeler */
function checkDoc(req, res) {
  const { coll, id } = req.params;
  if (!COLLS.has(coll) || !validId(id)) { res.status(400).json({ error: 'Geçersiz kayıt yolu' }); return false; }
  if (req.user.role === 'viewer') { res.status(403).json({ error: 'Görüntüleme yetkiniz var, değişiklik yapamazsınız' }); return false; }
  if (req.user.role === 'satici' && coll !== 'requests') { res.status(403).json({ error: 'Bu bölüm için yetkiniz yok' }); return false; }
  if (coll === 'announcements' && !STAFF_ROLES.has(req.user.role)) { res.status(403).json({ error: 'Duyuruyu yalnızca yönetim yayınlayabilir' }); return false; }
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
/* alan bazında değişiklik geçmişi */
const AUDIT_SKIP = new Set(['id', 'log', 'audit', 'comments', 'sms', 'attachments', 'parts', 'updatedAt', 'createdAt', 'createdBy', 'mailLog', 'reads', 'signature', 'publicToken', 'dupOf', 'slaBusiness', 'slaDays', 'imported']);
function flatDoc(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (AUDIT_SKIP.has(k) || /Id$/.test(k) || Array.isArray(v)) continue;
    if (v && typeof v === 'object') { for (const [k2, v2] of Object.entries(v)) { if (v2 !== null && typeof v2 === 'object') continue; out[k + '.' + k2] = v2; } }
    else out[k] = v;
  }
  return out;
}
function auditDiff(old, data) {
  const a = flatDoc(old), b = flatDoc(data); const ch = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? '', y = b[k] ?? '';
    if (String(x) !== String(y)) ch.push([k, x === '' ? null : String(x).slice(0, 200), y === '' ? null : String(y).slice(0, 200)]);
  }
  return ch;
}
async function onTicketChange(old, doc, actor, req) {
  const url = `${baseUrl(req)}/?k=${doc.id}`;
  if (doc.assigneeId && doc.assigneeId !== (old && old.assigneeId) && doc.assigneeId !== actor.id)
    pushUser(doc.assigneeId, { title: 'Size kayıt atandı', body: `${doc.no || ''} · ${doc.customerName || ''} · ${doc.productName || ''} (${actor.name})`, url, tag: 'as-' + doc.id });
  const oc = ((old && old.comments) || []).length, nc = (doc.comments || []).length;
  if (old && nc > oc) {
    const c = doc.comments[nc - 1] || {}; const text = String(c.text || '');
    const targets = new Set(); if (doc.assigneeId) targets.add(doc.assigneeId);
    if (text.includes('@')) {
      const { rows } = await pool.query("SELECT id, name FROM users WHERE status = 'active' AND role IN ('admin','user')");
      const low = text.toLocaleLowerCase('tr-TR');
      for (const u of rows) { const n = String(u.name || '').toLocaleLowerCase('tr-TR'); const first = n.split(' ')[0]; if (n && (low.includes('@' + n) || (first.length > 2 && low.includes('@' + first)))) targets.add(u.id); }
    }
    targets.delete(actor.id);
    for (const uid of targets) pushUser(uid, { title: `Yorum: ${doc.no || ''} · ${doc.customerName || ''}`, body: `${actor.name}: ${text.slice(0, 140)}`, url, tag: 'cm-' + doc.id });
  }
}
/* aynı müşteri + aynı ürün için açık / yakın tarihli talepler */
function normS(v) { return String(v || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' '); }
function phoneKey(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
async function findDupRequests(q, exceptId) {
  const code = String(q.productCode || '').trim().toUpperCase(), name = normS(q.productName);
  const cust = normS(q.customerName), ph = phoneKey(q.customerPhone);
  if ((!code && !name) || (!cust && !ph)) return [];
  const { rows } = await pool.query("SELECT id, data FROM docs WHERE coll = 'requests' AND id <> $1 AND (data->>'status' NOT IN ('tamamlandi','iptal') OR (data->>'createdAt') > $2)", [exceptId || '', new Date(Date.now() - 30 * 864e5).toISOString()]);
  return rows.filter(({ data: r }) => {
    const sameProd = (code && String(r.productCode || '').toUpperCase() === code) || (!code && name && normS(r.productName) === name) || (code && name && normS(r.productName) === name);
    const sameCust = (ph && phoneKey(r.customerPhone) === ph) || (cust && normS(r.customerName) === cust);
    return r.purpose === 'musteri' && sameProd && sameCust;
  }).map(({ id, data: r }) => ({ id, no: r.no, status: r.status, statusLabel: REQ_LABEL[r.status] || r.status, requesterName: r.requesterName || '', toBranch: r.toBranch || '', fromBranch: r.fromBranch || '', createdAt: r.createdAt, productName: r.productName, productCode: r.productCode, customerName: r.customerName }));
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
    const nowIso = new Date().toISOString();
    if (data.status === 'talep_edildi' && !data.requestedAt) data.requestedAt = nowIso;
    if (data.status === 'geldi' && !data.arrivedAt) data.arrivedAt = nowIso;
    if (data.status === 'tamamlandi' && !data.completedAt) { data.completedAt = nowIso; if (!data.arrivedAt) data.arrivedAt = nowIso; }
    if (data.status === 'iptal' && !data.cancelledAt) data.cancelledAt = nowIso;
    if (!old && data.purpose === 'musteri') { const d = await findDupRequests(data, id); data.dupOf = d.map(x => x.no).filter(Boolean).slice(0, 10); }
    else if (old) data.dupOf = old.dupOf || [];
  }
  if (coll === 'tickets' || coll === 'requests') {
    const at = new Date().toISOString();
    if (old) { const ch = auditDiff(old, data); data.audit = ch.length ? [...(old.audit || []), { at, by: req.user.id, byName: req.user.name, ch: ch.slice(0, 40) }].slice(-150) : (old.audit || []); }
    else data.audit = [{ at, by: req.user.id, byName: req.user.name, ch: [['_created', null, null]] }];
  }
  if (coll === 'announcements') {
    if (old) { data.reads = old.reads || {}; data.createdBy = old.createdBy; data.createdByName = old.createdByName; data.createdAt = old.createdAt; }
    else { data.reads = { [req.user.id]: new Date().toISOString() }; data.createdBy = req.user.id; data.createdByName = req.user.name; data.createdAt = new Date().toISOString(); }
  }
  const doc = await putDoc(coll, id, data);
  broadcast({ type: 'doc', coll, id, doc });
  res.json(doc);
  if (coll === 'requests') onRequestChange(old, doc, req.user, req).catch(e => console.warn(e.message));
  if (coll === 'announcements' && !old) {
    const [sql, params] = annTargetsSql(doc);
    const n = params.length + 1;
    pushTo(`${sql} AND u.id <> $${n}`, [...params, req.user.id], { title: (doc.pinned ? '📌 ' : '') + 'Duyuru: ' + (doc.title || ''), body: String(doc.body || '').slice(0, 140), url: `${baseUrl(req)}/#duyurular`, tag: 'ann-' + id });
  }
  if (coll === 'tickets') onTicketChange(old, doc, req.user, req).catch(e => console.warn(e.message));
  if (coll === 'requests' && !old && (doc.dupOf || []).length) pushStaff({ title: 'Mükerrer olabilecek talep', body: `${doc.customerName || ''} · ${doc.productName || ''} için zaten talep var: ${doc.dupOf.join(', ')}`, url: `${baseUrl(req)}/#talepler`, tag: 'dup-' + id }, req.user.id);
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
  if (old && coll !== 'settings') { const { id: _i, ...data } = old; await pool.query('INSERT INTO trash (coll, id, data, deleted_by, deleted_by_name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, deleted_by = EXCLUDED.deleted_by, deleted_by_name = EXCLUDED.deleted_by_name, deleted_at = now()', [coll, id, data, req.user.id, req.user.name]); }
  await pool.query('DELETE FROM docs WHERE coll = $1 AND id = $2', [coll, id]);
  broadcast({ type: 'doc', coll, id, doc: null, owner: old && old.requesterId });
  res.json({ ok: true, trashed: !!old });
}));

/* çöp kutusu */
const staffWrite = (req, res, next) => (STAFF_ROLES.has(req.user.role) ? next() : res.status(403).json({ error: 'Bu işlem için yetkiniz yok' }));
app.get('/api/trash', wrap(auth), staffWrite, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT coll, id, data, deleted_by_name, deleted_at FROM trash ORDER BY deleted_at DESC LIMIT 400');
  res.json({ days: TRASH_DAYS, items: rows.map(r => ({ coll: r.coll, id: r.id, deletedAt: r.deleted_at, deletedByName: r.deleted_by_name, title: r.data.no ? `${r.data.no} · ${r.data.customerName || r.data.productName || ''}` : (r.data.title || r.data.name || r.data.productName || r.id), sub: [r.data.productName, r.data.firmName || r.data.fromBranch, r.data.requesterName].filter(Boolean).join(' · ') })) });
}));
app.post('/api/trash/:coll/:id/restore', wrap(auth), staffWrite, wrap(async (req, res) => {
  const { coll, id } = req.params;
  if (!COLLS.has(coll) || !validId(id)) return res.status(400).json({ error: 'Geçersiz kayıt' });
  const { rows } = await pool.query('SELECT data FROM trash WHERE coll = $1 AND id = $2', [coll, id]);
  if (!rows[0]) return res.status(404).json({ error: 'Çöp kutusunda bulunamadı' });
  if (await getDoc(coll, id)) return res.status(409).json({ error: 'Bu kayıt zaten geri alınmış' });
  const data = rows[0].data;
  if (coll === 'tickets') data.log = [...(data.log || []), { at: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16), text: 'Çöp kutusundan geri alındı', by: req.user.id }].slice(-80);
  const doc = await putDoc(coll, id, data);
  await pool.query('DELETE FROM trash WHERE coll = $1 AND id = $2', [coll, id]);
  broadcast({ type: 'doc', coll, id, doc });
  res.json(doc);
}));
app.delete('/api/trash/:coll/:id', wrap(auth), isAdmin, wrap(async (req, res) => {
  const { coll, id } = req.params;
  const { rows } = await pool.query('DELETE FROM trash WHERE coll = $1 AND id = $2 RETURNING data', [coll, id]);
  if (rows[0] && coll === 'tickets') await dropFiles(ticketFileIds(rows[0].data));
  res.json({ ok: true });
}));

/* mükerrer talep kontrolü (satıcılar dahil) */
app.post('/api/requests/dupcheck', express.json({ limit: '10kb' }), wrap(auth), wrap(async (req, res) => {
  const b = req.body || {};
  const list = await findDupRequests(b, String(b.exceptId || ''));
  res.json({ items: list.slice(0, 10) });
}));

/* ürün kataloğu: barkod / madde kodu ile arama */
function prodOut(id, p, cats, firms) { return { id, name: p.name, code: p.code || '', barcode: p.barcode || '', categoryId: p.categoryId || '', categoryName: (cats && cats.get(p.categoryId)) || '', firmId: p.firmId || '', firmName: (firms && firms.get(p.firmId)) || '', warrantyMonths: p.warrantyMonths ?? null }; }
app.get('/api/lookup/product', wrap(auth), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 64);
  if (q.length < 3) return res.json({ item: null });
  const { rows } = await pool.query("SELECT id, data FROM docs WHERE coll = 'products' AND (upper(data->>'code') = upper($1) OR data->>'barcode' = $1 OR (data->'barcodes') ? $1) LIMIT 1", [q]);
  if (!rows[0]) return res.json({ item: null });
  const p = rows[0].data;
  const nm = await pool.query("SELECT coll, id, data->>'name' AS name FROM docs WHERE (coll = 'categories' AND id = $1) OR (coll = 'firms' AND id = $2)", [p.categoryId || '', p.firmId || '']);
  const cats = new Map(nm.rows.filter(r => r.coll === 'categories').map(r => [r.id, r.name])), firms = new Map(nm.rows.filter(r => r.coll === 'firms').map(r => [r.id, r.name]));
  res.json({ item: prodOut(rows[0].id, p, cats, firms) });
}));
app.post('/api/import/products', express.json({ limit: '12mb' }), wrap(auth), staffWrite, wrap(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows.slice(0, 30000) : [];
  if (!rows.length) return res.status(400).json({ error: 'Aktarılacak satır yok' });
  const all = await pool.query("SELECT coll, id, data FROM docs WHERE coll IN ('firms','categories','products')");
  const byName = { firms: new Map(), categories: new Map() };
  const pCode = new Map(), pBar = new Map(), pName = new Map(), prods = new Map();
  for (const r of all.rows) {
    if (byName[r.coll]) byName[r.coll].set(normS(r.data.name), r.id);
    else { prods.set(r.id, r.data); if (r.data.code) pCode.set(String(r.data.code).toUpperCase(), r.id); if (r.data.barcode) pBar.set(String(r.data.barcode), r.id); if (r.data.name) pName.set(normS(r.data.name), r.id); }
  }
  const nowIso = new Date().toISOString(); const extra = [];
  const ensure = (coll, name) => { const k = normS(name); if (!k) return ''; if (byName[coll].has(k)) return byName[coll].get(k); const id = newId(); byName[coll].set(k, id); extra.push({ coll, id, data: { name: String(name).trim().slice(0, 120), createdAt: nowIso } }); return id; };
  let added = 0, updated = 0, skipped = 0; const out = new Map();
  for (const r of rows) {
    if (!r) { skipped++; continue; }
    const code = String(r.code || '').trim().toUpperCase().slice(0, 40), barcode = String(r.barcode || '').replace(/\s/g, '').slice(0, 40), name = String(r.name || '').trim().slice(0, 160);
    if (!name || (!code && !barcode)) { skipped++; continue; }
    const id = (code && pCode.get(code)) || (barcode && pBar.get(barcode)) || pName.get(normS(name)) || null;
    const base = id ? { ...(out.get(id) || prods.get(id)) } : { createdAt: nowIso };
    base.name = name; if (code) base.code = code; if (barcode) base.barcode = barcode;
    if (r.category) base.categoryId = ensure('categories', r.category);
    if (r.firm) base.firmId = ensure('firms', r.firm);
    if (r.brand) base.brand = String(r.brand).trim().slice(0, 80);
    const wm = Number(r.warrantyMonths); if (r.warrantyMonths !== '' && r.warrantyMonths != null && wm >= 0 && wm <= 120) base.warrantyMonths = wm;
    base.updatedAt = nowIso;
    const pid = id || newId();
    if (id) { if (!out.has(id)) updated++; } else added++;
    out.set(pid, base); if (code) pCode.set(code, pid); if (barcode) pBar.set(barcode, pid); pName.set(normS(name), pid);
  }
  const items = [...extra, ...[...out].map(([id, data]) => ({ coll: 'products', id, data }))];
  for (let i = 0; i < items.length; i += 2000)
    await pool.query('INSERT INTO docs (coll, id, data) SELECT x.coll, x.id, x.data FROM jsonb_to_recordset($1::jsonb) AS x(coll text, id text, data jsonb) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [JSON.stringify(items.slice(i, i + 2000))]);
  broadcast({ type: 'reload' });
  res.json({ ok: true, added, updated, skipped });
}));

/* duyuru okundu */
app.post('/api/ann/:id/read', wrap(auth), wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Geçersiz duyuru' });
  const a = await getDoc('announcements', req.params.id);
  if (!a || !annVisible(req.user, a)) return res.status(404).json({ error: 'Duyuru bulunamadı' });
  const { id, ...data } = a;
  data.reads = { ...(a.reads || {}) };
  if (!data.reads[req.user.id]) data.reads[req.user.id] = new Date().toISOString();
  const doc = await putDoc('announcements', id, data);
  broadcast({ type: 'doc', coll: 'announcements', id, doc });
  res.json(doc);
}));

/* toplu içe aktarma (Excel) */
app.post('/api/import/tickets', express.json({ limit: '8mb' }), wrap(auth), (req, res, next) => (STAFF_ROLES.has(req.user.role) ? next() : res.status(403).json({ error: 'Yetkiniz yok' })), wrap(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows.slice(0, 5000) : [];
  if (!rows.length) return res.status(400).json({ error: 'Aktarılacak satır yok' });
  const all = await pool.query("SELECT coll, id, data FROM docs WHERE coll IN ('firms','customers','categories','products','tickets')");
  const idx = { firms: new Map(), customers: new Map(), categories: new Map(), products: new Map() };
  const nos = new Set();
  const norm = v => String(v || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
  for (const r of all.rows) { if (idx[r.coll]) idx[r.coll].set(norm(r.data.name), r.id); if (r.coll === 'tickets' && r.data.no) nos.add(r.data.no); }
  const nowIso = new Date().toISOString();
  async function ensure(coll, name, extra) {
    const k = norm(name); if (!k) return '';
    if (idx[coll].has(k)) return idx[coll].get(k);
    const id = newId(); await pool.query('INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3)', [coll, id, { name: String(name).trim(), createdAt: nowIso, ...extra }]);
    idx[coll].set(k, id); return id;
  }
  let added = 0, skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      if (!r || !r.customerName || !r.productName) { skipped++; continue; }
      if (r.no && nos.has(r.no)) { skipped++; continue; }
      const firmId = await ensure('firms', r.firmName, {});
      const categoryId = await ensure('categories', r.categoryName || 'Diğer', {});
      const customerId = await ensure('customers', r.customerName, r.customerPhone ? { phone: r.customerPhone } : {});
      const productId = await ensure('products', r.productName, { categoryId, firmId });
      const id = newId();
      const no = r.no || ('ARZ-' + String(r.openedAt || '').slice(2).replace(/-/g, '') + '-' + id.slice(-4).toUpperCase());
      nos.add(no);
      const doc = { ...r, no, firmId, categoryId, customerId, productId, categoryName: r.categoryName || 'Diğer', publicToken: newId(), parts: [], attachments: [], comments: [], sms: [],
        createdAt: nowIso, updatedAt: nowIso, createdBy: req.user.id, imported: true, log: [{ at: nowIso.slice(0, 16).replace('T', ' '), text: 'Excel\'den içe aktarıldı', by: req.user.id }] };
      await client.query('INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3)', ['tickets', id, doc]);
      added++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  broadcast({ type: 'reload' });
  res.json({ ok: true, added, skipped });
}));

/* yedekleme */
const BK_STATUS = { teslim_alindi: 'Teslim Alındı', servise_gonderildi: 'Servise Gönderildi', serviste: 'Serviste', servisten_geldi: 'Servisten Geldi', musteriye_teslim: 'Müşteriye Teslim', fatura_talep: 'Fatura Talebi', faturalandi: 'Faturalandı', kapandi: 'Kapandı', acik: 'Teslim Alındı', islemde: 'Serviste', parca: 'Serviste' };
async function buildBackup() {
  const [docs, users] = await Promise.all([
    pool.query('SELECT coll, id, data FROM docs ORDER BY coll, id'),
    pool.query('SELECT id, username, name, role, email, branch, phone, status, created_at FROM users ORDER BY name'),
  ]);
  const data = {}; for (const c of COLLS) data[c] = [];
  for (const r of docs.rows) (data[r.coll] = data[r.coll] || []).push({ id: r.id, ...r.data });
  const json = { app: APP_NAME, version: 1, createdAt: new Date().toISOString(), data, users: users.rows };
  let xlsx = null;
  if (XLSX) {
    const wb = XLSX.utils.book_new();
    const add = (name, rows) => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Bilgi: 'Kayıt yok' }]); XLSX.utils.book_append_sheet(wb, ws, name); };
    add('Arıza kayıtları', data.tickets.map(t => ({ 'Kayıt No': t.no, 'Kayıt Tarihi': t.openedAt, 'Durum': BK_STATUS[t.status] || t.status, 'Müşteri': t.customerName, 'Telefon': t.customerPhone || '', 'Ürün': t.productName, 'Madde Kodu': t.productCode || '', 'Barkod': t.barcode || '', 'Kategori': t.categoryName, 'Firma': t.firmName, 'Seri No': t.serial || '', 'Arıza': t.desc || '', 'Garanti': t.warranty || '', 'Satış Tarihi': t.purchaseDate || '', 'Garanti Bitişi': t.warrantyEnd || '', 'Servise Gönderim': t.sentAt || '', 'Servisten Geliş': t.backAt || '', 'Müşteriye Teslim': t.deliveredAt || '', 'Fatura Son Tarihi': t.dueAt || '', 'Fatura No': t.invoiceNo || '', 'Fatura Tarihi': t.invoicedAt || '', 'Tutar (TL)': t.invoiceAmount ?? '', 'Memnuniyet': t.rating ? t.rating.score : '', 'Not': t.note || '' })));
    add('Ürün talepleri', data.requests.map(r => ({ 'Talep No': r.no, 'Tarih': (r.createdAt || '').slice(0, 10), 'Durum': REQ_LABEL[r.status] || r.status, 'Ürün': r.productName, 'Kod': r.productCode, 'Adet': r.qty, 'İstenen Şube': r.fromBranch, 'Talep Eden Şube': r.toBranch || '', 'Kimin İçin': r.purpose === 'musteri' ? 'Müşteri' : 'Mağaza', 'Müşteri': r.customerName || '', 'Satıcı': r.requesterName || '', 'Geliş': (r.arrivedAt || '').slice(0, 10) })));
    { const cn = new Map(data.categories.map(c => [c.id, c.name])), fn = new Map(data.firms.map(f => [f.id, f.name]));
      add('Ürün kataloğu', data.products.map(p => ({ 'Madde Kodu': p.code || '', 'Barkod': p.barcode || '', 'Ürün Adı': p.name, 'Kategori': cn.get(p.categoryId) || '', 'Marka / Firma': fn.get(p.firmId) || '', 'Garanti (ay)': p.warrantyMonths ?? '' }))); }
    add('Müşteriler', data.customers.map(c => ({ 'Ad': c.name, 'Telefon': c.phone || '', 'Adres': c.address || '' })));
    add('Firmalar', data.firms.map(f => ({ 'Ad': f.name, 'Telefon': f.phone || '', 'E-posta': f.email || '' })));
    add('Şubeler', data.branches.map(b => ({ 'Ad': b.name, 'Telefon': b.phone || '' })));
    add('Sevkiyatlar', data.shipments.map(s => ({ 'Sevk No': s.no, 'Tarih': s.date, 'Firma': s.firmName || '', 'Takip No': s.trackNo || '', 'Ürün sayısı': (s.ticketIds || []).length })));
    add('Duyurular', data.announcements.map(a => ({ 'Başlık': a.title, 'Tarih': (a.createdAt || '').slice(0, 10), 'Kime': a.audience || 'all', 'Okuyan': Object.keys(a.reads || {}).length })));
    add('Kullanıcılar', users.rows.map(u => ({ 'Ad': u.name, 'Kullanıcı adı': u.username, 'E-posta': u.email || '', 'Rol': u.role, 'Şube': u.branch || '', 'Durum': u.status })));
    xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
  return { json, xlsx, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) };
}
async function sendBackup(to) {
  if (!to) return { ok: false, reason: 'no_recipient' };
  const b = await buildBackup();
  const day = istNow().date;
  const attachments = [{ filename: `umraniye-sampiyonlari-yedek-${day}.json`, content: Buffer.from(JSON.stringify(b.json)).toString('base64'), content_type: 'application/json' }];
  if (b.xlsx) attachments.unshift({ filename: `umraniye-sampiyonlari-yedek-${day}.xlsx`, content: b.xlsx.toString('base64'), content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const c = b.counts;
  return sendMail({ to, subject: `Yedek ${trDate(day)} – ${c.tickets} kayıt, ${c.requests} talep`,
    html: mailLayout(`Günlük yedek · ${trDate(day)}`, `<p>Tüm veriler ektedir: <b>${c.tickets}</b> arıza kaydı, <b>${c.requests}</b> ürün talebi, <b>${c.customers}</b> müşteri, <b>${c.firms}</b> firma, <b>${c.announcements}</b> duyuru.</p><p>Excel dosyasını açarak inceleyebilirsiniz. JSON dosyası, gerektiğinde Tanımlar ve Ayarlar → Yedekleme bölümünden geri yüklemek içindir. Fotoğraf ve belgeler yedeğe dahil değildir.</p>`),
    text: `Günlük yedek ektedir. ${c.tickets} kayıt, ${c.requests} talep.`, attachments });
}
app.get('/api/backup/download', wrap(auth), isAdmin, wrap(async (req, res) => {
  const b = await buildBackup();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="umraniye-sampiyonlari-yedek-${istNow().date}.json"`);
  res.send(JSON.stringify(b.json));
}));
app.get('/api/backup/excel', wrap(auth), isAdmin, wrap(async (req, res) => {
  const b = await buildBackup();
  if (!b.xlsx) return res.status(500).json({ error: 'Excel oluşturulamadı' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="umraniye-sampiyonlari-yedek-${istNow().date}.xlsx"`);
  res.send(b.xlsx);
}));
app.post('/api/backup/send', wrap(auth), isAdmin, wrap(async (req, res) => {
  const st = await getSettings();
  res.json(await sendBackup(st.backupEmail || st.reportEmail));
}));
app.post('/api/backup/restore', express.json({ limit: '25mb' }), wrap(auth), isAdmin, wrap(async (req, res) => {
  const d = req.body && req.body.data;
  if (!d || typeof d !== 'object') return res.status(400).json({ error: 'Geçersiz yedek dosyası' });
  let n = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [coll, items] of Object.entries(d)) {
      if (!COLLS.has(coll) || !Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || !validId(it.id)) continue;
        const { id, ...data } = it;
        await client.query('INSERT INTO docs (coll, id, data) VALUES ($1,$2,$3) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [coll, id, data]);
        n++;
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  broadcast({ type: 'reload' });
  res.json({ ok: true, restored: n });
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
    ${req.query.ok ? `<div class="box okb">${req.query.ok === 'onay' ? 'Onayınız alındı, teşekkür ederiz. Onarım başlatılacak.' : req.query.ok === 'puan' ? 'Değerlendirmeniz için teşekkür ederiz.' : 'Kararınız kaydedildi. Mağazamız sizinle iletişime geçecek.'}</div>` : ''}
    ${quote}<ol class="steps">${steps}</ol>
    ${t.serviceResult && RESULT[t.serviceResult] ? `<div class="box"><p>Servis sonucu: <b>${esc(RESULT[t.serviceResult])}</b></p></div>` : ''}
    ${t.warrantyEnd ? `<div class="box"><p>Garanti bitiş tarihi: <b>${esc(trDate(t.warrantyEnd))}</b></p></div>` : ''}
    ${idx >= 4 ? (t.rating ? `<div class="box okb"><p>Değerlendirmeniz için teşekkür ederiz: <b>${'★'.repeat(t.rating.score)}${'☆'.repeat(5 - t.rating.score)}</b></p></div>` : `<div class="box"><h2>Hizmetimizi değerlendirin</h2><p>Bu süreçten ne kadar memnun kaldınız?</p>
      <form method="post" action="/takip/${esc(req.params.token)}/puan" class="rate"><div class="stars">${[5, 4, 3, 2, 1].map(n => `<input type="radio" name="puan" value="${n}" id="p${n}" required><label for="p${n}" title="${n} yıldız">★</label>`).join('')}</div>
      <textarea name="yorum" maxlength="500" placeholder="Eklemek istediğiniz bir şey var mı? (isteğe bağlı)"></textarea><button class="ok" type="submit">Gönder</button></form></div>`) : ''}`;
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
app.post('/takip/:token/puan', express.urlencoded({ extended: false, limit: '4kb' }), wrap(async (req, res) => {
  if (limited('rate:' + req.ip, 20, 60 * 60e3)) return res.status(429).send('Çok fazla istek');
  const t = await ticketByToken(req.params.token);
  const score = Math.round(Number(req.body.puan));
  if (!t || t.rating || !(score >= 1 && score <= 5) || (ORDER[t.status] ?? 0) < 4) return res.redirect(`/takip/${encodeURIComponent(req.params.token)}`);
  const comment = String(req.body.yorum || '').trim().slice(0, 500);
  const now = new Date();
  const { id, ...rest } = t;
  const data = { ...rest, rating: { score, comment, at: now.toISOString() }, updatedAt: now.toISOString(),
    log: [...(t.log || []), { at: now.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16), text: `Müşteri ${score}/5 puan verdi${comment ? ': ' + comment.slice(0, 80) : ''}`, by: null }].slice(-80) };
  const doc = await putDoc('tickets', id, data);
  broadcast({ type: 'doc', coll: 'tickets', id, doc });
  if (score <= 2) pushStaff({ title: `Düşük memnuniyet puanı: ${score}/5`, body: `${t.no} · ${t.customerName || ''} · ${t.firmName || ''}${comment ? ' · ' + comment.slice(0, 80) : ''}`, url: `${baseUrl(req)}/?k=${id}`, tag: 'rate-' + id });
  res.redirect(`/takip/${encodeURIComponent(req.params.token)}?ok=puan`);
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
  footer{color:var(--muted);font-size:.85rem;margin-top:24px}
  .rate{flex-direction:column;align-items:stretch}.stars{display:flex;flex-direction:row-reverse;justify-content:flex-end;gap:4px}
  .stars input{position:absolute;opacity:0;width:1px;height:1px}.stars label{font-size:2.4rem;line-height:1;color:var(--line);cursor:pointer;padding:0 2px}
  .stars input:checked~label,.stars label:hover,.stars label:hover~label{color:var(--gold)}.stars input:focus-visible+label{outline:2px solid var(--acc);border-radius:4px}
  textarea{font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--card);color:var(--fg);min-height:70px}</style></head>
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
