'use strict';
/*
 * Ümraniye Şampiyonları — sohbet, sesli/görüntülü arama ve mini oyunlar
 * server.js içindeki ortak araçlarla kurulur: setup(ctx)
 */
module.exports = function setup(ctx) {
  const { app, pool, express, wrap, auth, isAdmin, newId, clients, pushUser, baseUrl, validId, APP_NAME } = ctx;
  const json = express.json({ limit: '40kb' });
  const STAFF = new Set(['admin', 'user']);
  const IMG = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
  const nowIso = () => new Date().toISOString();
  const lower = s => String(s || '').toLocaleLowerCase('tr-TR');

  /* ---------------- şema ---------------- */
  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', topic TEXT, audience TEXT NOT NULL DEFAULT 'all',
        position INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'text',
        reply_to TEXT, reactions JSONB NOT NULL DEFAULT '{}', files JSONB NOT NULL DEFAULT '[]', meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), edited_at TIMESTAMPTZ, deleted BOOLEAN NOT NULL DEFAULT false);
      CREATE INDEX IF NOT EXISTS chat_messages_ch ON chat_messages (channel, created_at DESC);
      CREATE TABLE IF NOT EXISTS chat_reads (user_id TEXT NOT NULL, channel TEXT NOT NULL, read_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, channel));
      ALTER TABLE files ADD COLUMN IF NOT EXISTS scope TEXT;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, players JSONB NOT NULL, state JSONB NOT NULL, status TEXT NOT NULL,
        winner TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS game_scores (
        id BIGSERIAL PRIMARY KEY, game TEXT NOT NULL, user_id TEXT NOT NULL, score INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS game_scores_g ON game_scores (game, score DESC);
    `);
    const n = await pool.query('SELECT count(*)::int AS n FROM chat_channels');
    if (n.rows[0].n === 0) {
      const seed = [['genel', 'genel', 'text', 'Herkesin sohbet kanalı', 'all', 0], ['servis', 'servis-takip', 'text', 'Arıza kayıtları ve servis işleri', 'staff', 1], ['talepler', 'ürün-talepleri', 'text', 'Şubeler arası ürün istekleri', 'all', 2],
        ['sesli-oda', 'Sesli Oda', 'voice', null, 'all', 10], ['toplanti', 'Toplantı', 'voice', null, 'staff', 11]];
      for (const s of seed) await pool.query('INSERT INTO chat_channels (id, name, kind, topic, audience, position) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', s);
    }
    await loadChannels();
  }
  const chans = new Map();
  async function loadChannels() { const { rows } = await pool.query('SELECT * FROM chat_channels ORDER BY kind, position, name'); chans.clear(); rows.forEach(r => chans.set(r.id, r)); }
  const chanOut = c => ({ id: c.id, name: c.name, kind: c.kind, topic: c.topic || '', audience: c.audience, position: c.position });

  /* ---------------- erişim ---------------- */
  const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');
  const dmPeers = ch => ch.slice(3).split('_');
  function audienceOk(user, aud) {
    if (user.role !== 'satici') return true;
    aud = aud || 'all';
    if (aud === 'all' || aud === 'satici') return true;
    if (aud.startsWith('branch:')) return (user.branch || '') === aud.slice(7);
    return false;
  }
  const callInvites = new Map(); // room -> {from, fromName, to, video, at}
  function canAccess(user, ch) {
    if (typeof ch !== 'string') return false;
    if (ch.startsWith('dm_')) return dmPeers(ch).includes(user.id);
    if (ch.startsWith('call_')) { const inv = callInvites.get(ch); return !!inv && (inv.from === user.id || inv.to === user.id); }
    const c = chans.get(ch); return !!c && audienceOk(user, c.audience);
  }
  const canWrite = user => user.role !== 'viewer';

  /* ---------------- canlı dağıtım ---------------- */
  const write = (c, evt) => { try { c.res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { clients.delete(c); } };
  const sendToUser = (uid, evt) => { for (const c of clients) if (c.user.id === uid) write(c, evt); };
  const sendToCid = (cid, evt) => { for (const c of clients) if (c.cid === cid) { write(c, evt); return true; } return false; };
  const sendToChannel = (ch, evt, exceptUid) => { for (const c of clients) if (c.user.id !== exceptUid && canAccess(c.user, ch)) write(c, evt); };
  const online = () => [...new Set([...clients].map(c => c.user.id))];
  let presT = null;
  function presenceChanged() { clearTimeout(presT); presT = setTimeout(() => { const ids = online(); for (const c of clients) write(c, { type: 'presence', online: ids }); }, 400); }

  /* sesli odalar */
  const rooms = new Map(); // room -> Map(cid -> participant)
  function voiceFor(user) {
    const out = {};
    for (const [room, m] of rooms) if (m.size && canAccess(user, room)) out[room] = [...m.values()];
    return out;
  }
  function voiceChanged() { for (const c of clients) write(c, { type: 'voice', rooms: voiceFor(c.user) }); }
  function leaveRoom(room, cid) {
    const m = rooms.get(room); if (!m || !m.has(cid)) return;
    m.delete(cid);
    for (const p of m.values()) sendToCid(p.cid, { type: 'peer-left', room, cid });
    if (!m.size) { rooms.delete(room); if (room.startsWith('call_')) callInvites.delete(room); }
  }
  function leaveAll(cid) { let any = false; for (const [room, m] of [...rooms]) if (m.has(cid)) { leaveRoom(room, cid); any = true; } if (any) voiceChanged(); }

  function onConnect(c) {
    write(c, { type: 'hello', cid: c.cid }); presenceChanged(); write(c, { type: 'voice', rooms: voiceFor(c.user) });
    for (const [room, inv] of callInvites) if (inv.to === c.user.id && Date.now() - inv.at < 45000 && rooms.get(room) && rooms.get(room).size) write(c, { type: 'ring', room, from: { id: inv.from, name: inv.fromName }, video: inv.video });
  }
  function onDisconnect(c) { leaveAll(c.cid); presenceChanged(); }
  function canSee(user, evt) { if (evt.type === 'chat' || evt.type === 'typing') return canAccess(user, evt.ch); return null; }

  /* ---------------- yardımcılar ---------------- */
  async function activeUsers() { const { rows } = await pool.query("SELECT id, name, role, branch FROM users WHERE status = 'active' ORDER BY name"); return rows; }
  async function visibleChannels(user) { return [...chans.values()].filter(c => audienceOk(user, c.audience)).sort((a, b) => (a.kind === b.kind ? a.position - b.position || a.name.localeCompare(b.name, 'tr') : a.kind === 'text' ? -1 : 1)).map(chanOut); }
  async function msgRows(where, params, limit) {
    const { rows } = await pool.query(`SELECT m.*, u.name AS uname, r.text AS r_text, r.deleted AS r_deleted, ru.name AS r_name
      FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN chat_messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
      WHERE ${where} ORDER BY m.created_at DESC LIMIT ${Math.min(Number(limit) || 50, 200)}`, params);
    return rows.map(outMsg);
  }
  function outMsg(m) {
    return { id: m.id, ch: m.channel, uid: m.user_id, name: m.uname || 'Silinmiş kullanıcı', text: m.deleted ? '' : m.text, kind: m.kind, at: m.created_at, editedAt: m.edited_at, deleted: m.deleted,
      replyTo: m.reply_to, reply: m.reply_to ? { id: m.reply_to, name: m.r_name || '', text: m.r_deleted ? '(silinen mesaj)' : String(m.r_text || '').slice(0, 140) } : null,
      reactions: m.reactions || {}, files: m.deleted ? [] : (m.files || []), meta: m.meta || null };
  }
  async function getMsg(id) { const r = await msgRows('m.id = $1', [id], 1); return r[0] || null; }
  async function insertMsg(ch, uid, text, opts = {}) {
    const id = newId(16);
    await pool.query('INSERT INTO chat_messages (id, channel, user_id, text, kind, reply_to, files, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, ch, uid, text, opts.kind || 'text', opts.replyTo || null, JSON.stringify(opts.files || []), opts.meta ? JSON.stringify(opts.meta) : null]);
    const msg = await getMsg(id);
    sendToChannel(ch, { type: 'chat', op: 'new', ch, msg });
    return msg;
  }
  const chUrl = (req, ch) => `${baseUrl(req)}/?ch=${encodeURIComponent(ch)}#sohbet`;
  const chLabel = ch => ch.startsWith('dm_') ? 'Özel mesaj' : '#' + ((chans.get(ch) || {}).name || ch);

  /* ---------------- sohbet uçları ---------------- */
  app.get('/api/chat/state', wrap(auth), wrap(async (req, res) => {
    const u = req.user;
    const channels = await visibleChannels(u);
    const ids = channels.filter(c => c.kind === 'text').map(c => c.id);
    const [unread, last, dms, users, reads] = await Promise.all([
      pool.query(`SELECT m.channel, count(*)::int AS n FROM chat_messages m LEFT JOIN chat_reads r ON r.channel = m.channel AND r.user_id = $1
        WHERE m.user_id <> $1 AND NOT m.deleted AND m.created_at > coalesce(r.read_at, 'epoch') AND (m.channel = ANY($2) OR (m.channel LIKE 'dm\\_%' AND position($1 in m.channel) > 0)) GROUP BY m.channel`, [u.id, ids]),
      pool.query(`SELECT DISTINCT ON (m.channel) m.channel, m.text, m.kind, m.created_at, m.user_id, us.name AS uname FROM chat_messages m LEFT JOIN users us ON us.id = m.user_id
        WHERE NOT m.deleted AND (m.channel = ANY($2) OR (m.channel LIKE 'dm\\_%' AND position($1 in m.channel) > 0)) ORDER BY m.channel, m.created_at DESC`, [u.id, ids]),
      pool.query(`SELECT DISTINCT channel FROM chat_messages WHERE channel LIKE 'dm\\_%' AND position($1 in channel) > 0`, [u.id]),
      activeUsers(),
      pool.query('SELECT channel, read_at FROM chat_reads WHERE user_id = $1', [u.id]),
    ]);
    res.json({
      me: u.id, channels, users, online: online(), voice: voiceFor(u),
      dms: dms.rows.map(r => r.channel),
      unread: Object.fromEntries(unread.rows.map(r => [r.channel, r.n])),
      last: Object.fromEntries(last.rows.map(r => [r.channel, { at: r.created_at, text: String(r.text || '').slice(0, 90), kind: r.kind, uid: r.user_id, name: r.uname }])),
      reads: Object.fromEntries(reads.rows.map(r => [r.channel, r.read_at])),
      ice: iceServers(),
    });
  }));
  app.get('/api/chat/messages', wrap(auth), wrap(async (req, res) => {
    const ch = String(req.query.ch || '');
    if (!canAccess(req.user, ch)) return res.status(403).json({ error: 'Bu kanala erişiminiz yok' });
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const list = before && !isNaN(before) ? await msgRows('m.channel = $1 AND m.created_at < $2', [ch, before.toISOString()], req.query.limit) : await msgRows('m.channel = $1', [ch], req.query.limit);
    res.json({ items: list.reverse(), more: list.length >= (Math.min(Number(req.query.limit) || 50, 200)) });
  }));
  app.get('/api/chat/search', wrap(auth), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ items: [] });
    const ch = String(req.query.ch || '');
    const ids = (await visibleChannels(req.user)).filter(c => c.kind === 'text').map(c => c.id);
    const esc = q.replace(/[\\%_]/g, m => '\\' + m);
    const list = ch && canAccess(req.user, ch)
      ? await msgRows("m.channel = $1 AND NOT m.deleted AND m.text ILIKE $2", [ch, '%' + esc + '%'], 60)
      : await msgRows("NOT m.deleted AND m.text ILIKE $3 AND (m.channel = ANY($2) OR (m.channel LIKE 'dm\\_%' AND position($1 in m.channel) > 0))", [req.user.id, ids, '%' + esc + '%'], 60);
    res.json({ items: list });
  }));
  app.post('/api/chat/messages', json, wrap(auth), wrap(async (req, res) => {
    const u = req.user; const b = req.body || {};
    let ch = String(b.ch || '');
    if (b.toUser && validId(b.toUser)) ch = dmId(u.id, b.toUser);
    if (!canAccess(u, ch) || !canWrite(u)) return res.status(403).json({ error: 'Bu kanala yazamazsınız' });
    const text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 4000);
    const files = Array.isArray(b.files) ? b.files.filter(f => f && validId(f.id)).slice(0, 6).map(f => ({ id: f.id, name: String(f.name || 'dosya').slice(0, 120), type: String(f.type || ''), size: Number(f.size) || 0 })) : [];
    if (!text && !files.length) return res.status(400).json({ error: 'Mesaj boş' });
    const replyTo = b.replyTo && validId(b.replyTo) ? b.replyTo : null;
    const msg = await insertMsg(ch, u.id, text, { replyTo, files });
    await pool.query('INSERT INTO chat_reads (user_id, channel, read_at) VALUES ($1,$2, now()) ON CONFLICT (user_id, channel) DO UPDATE SET read_at = now()', [u.id, ch]);
    res.json(msg);
    // bildirimler: özel mesaj ve @bahsetme
    const targets = new Set();
    if (ch.startsWith('dm_')) dmPeers(ch).filter(x => x !== u.id).forEach(x => targets.add(x));
    if (text.includes('@')) {
      const low = lower(text);
      for (const x of await activeUsers()) { const n = lower(x.name); const f = n.split(' ')[0]; if (x.id !== u.id && (low.includes('@' + n) || (f.length > 2 && low.includes('@' + f))) && canAccess(x, ch)) targets.add(x.id); }
    }
    if (replyTo) { const r = await pool.query('SELECT user_id FROM chat_messages WHERE id = $1', [replyTo]); if (r.rows[0] && r.rows[0].user_id !== u.id) targets.add(r.rows[0].user_id); }
    const preview = text || (files.length ? '📎 ' + files[0].name : '');
    for (const t of targets) pushUser(t, { title: ch.startsWith('dm_') ? u.name : `${u.name} · ${chLabel(ch)}`, body: preview.slice(0, 140), url: chUrl(req, ch), tag: 'chat-' + ch });
  }));
  app.patch('/api/chat/messages/:id', json, wrap(auth), wrap(async (req, res) => {
    const m = (await pool.query('SELECT * FROM chat_messages WHERE id = $1', [req.params.id])).rows[0];
    if (!m || m.deleted) return res.status(404).json({ error: 'Mesaj bulunamadı' });
    if (m.user_id !== req.user.id) return res.status(403).json({ error: 'Sadece kendi mesajınızı düzenleyebilirsiniz' });
    const text = String((req.body || {}).text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'Mesaj boş olamaz' });
    await pool.query('UPDATE chat_messages SET text = $1, edited_at = now() WHERE id = $2', [text, m.id]);
    const msg = await getMsg(m.id); sendToChannel(m.channel, { type: 'chat', op: 'edit', ch: m.channel, msg }); res.json(msg);
  }));
  app.delete('/api/chat/messages/:id', wrap(auth), wrap(async (req, res) => {
    const m = (await pool.query('SELECT * FROM chat_messages WHERE id = $1', [req.params.id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Mesaj bulunamadı' });
    if (m.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Bu mesajı silemezsiniz' });
    await pool.query("UPDATE chat_messages SET deleted = true, text = '', files = '[]' WHERE id = $1", [m.id]);
    const ids = (m.files || []).map(f => f.id).filter(validId);
    if (ids.length) await pool.query("DELETE FROM files WHERE id = ANY($1::text[]) AND scope = 'chat'", [ids]);
    const msg = await getMsg(m.id); sendToChannel(m.channel, { type: 'chat', op: 'edit', ch: m.channel, msg }); res.json({ ok: true });
  }));
  const EMOJI = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅', '👀', '🎉']);
  app.post('/api/chat/messages/:id/react', json, wrap(auth), wrap(async (req, res) => {
    const e = String((req.body || {}).emoji || '');
    if (!EMOJI.has(e)) return res.status(400).json({ error: 'Geçersiz tepki' });
    const m = (await pool.query('SELECT * FROM chat_messages WHERE id = $1', [req.params.id])).rows[0];
    if (!m || m.deleted || !canAccess(req.user, m.channel)) return res.status(404).json({ error: 'Mesaj bulunamadı' });
    const r = { ...(m.reactions || {}) }; const list = new Set(r[e] || []);
    if (list.has(req.user.id)) list.delete(req.user.id); else list.add(req.user.id);
    if (list.size) r[e] = [...list]; else delete r[e];
    await pool.query('UPDATE chat_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(r), m.id]);
    const msg = await getMsg(m.id); sendToChannel(m.channel, { type: 'chat', op: 'edit', ch: m.channel, msg }); res.json(msg);
  }));
  app.post('/api/chat/read', json, wrap(auth), wrap(async (req, res) => {
    const ch = String((req.body || {}).ch || '');
    if (!canAccess(req.user, ch)) return res.status(403).json({ error: 'Erişim yok' });
    await pool.query('INSERT INTO chat_reads (user_id, channel, read_at) VALUES ($1,$2, now()) ON CONFLICT (user_id, channel) DO UPDATE SET read_at = now()', [req.user.id, ch]);
    res.json({ ok: true });
  }));
  app.post('/api/chat/typing', json, wrap(auth), (req, res) => {
    const ch = String((req.body || {}).ch || '');
    if (canAccess(req.user, ch)) sendToChannel(ch, { type: 'typing', ch, uid: req.user.id, name: req.user.name }, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/chat/channels', json, wrap(auth), (req, res, next) => (STAFF.has(req.user.role) ? next() : res.status(403).json({ error: 'Kanalı yönetim açabilir' })), wrap(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'voice' ? 'voice' : 'text';
    let name = String(b.name || '').trim().slice(0, 40);
    if (kind === 'text') name = lower(name).replace(/\s+/g, '-').replace(/[^a-z0-9çğıöşü\-]/g, '');
    if (name.length < 2) return res.status(400).json({ error: 'Kanal adı en az 2 karakter olmalı' });
    const aud = typeof b.audience === 'string' && /^(all|staff|satici|branch:.{1,80})$/.test(b.audience) ? b.audience : 'all';
    const id = newId(10);
    const pos = [...chans.values()].filter(c => c.kind === kind).reduce((a, c) => Math.max(a, c.position), 0) + 1;
    await pool.query('INSERT INTO chat_channels (id, name, kind, topic, audience, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, name, kind, String(b.topic || '').slice(0, 160) || null, aud, pos, req.user.id]);
    await loadChannels();
    for (const c of clients) write(c, { type: 'channels' });
    res.json(chanOut(chans.get(id)));
  }));
  app.delete('/api/chat/channels/:id', wrap(auth), isAdmin, wrap(async (req, res) => {
    const c = chans.get(req.params.id); if (!c) return res.status(404).json({ error: 'Kanal bulunamadı' });
    if (c.id === 'genel') return res.status(400).json({ error: '#genel kanalı silinemez' });
    await pool.query('DELETE FROM chat_channels WHERE id = $1', [c.id]);
    await pool.query('DELETE FROM chat_messages WHERE channel = $1', [c.id]);
    await loadChannels();
    for (const cl of clients) write(cl, { type: 'channels' });
    res.json({ ok: true });
  }));
  app.post('/api/chat/files', wrap(auth), (req, res, next) => (canWrite(req.user) ? next() : res.status(403).json({ error: 'Yetkiniz yok' })), express.raw({ type: () => true, limit: 10 * 1024 * 1024 }), wrap(async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!IMG.has(type)) return res.status(415).json({ error: 'Yalnızca fotoğraf (JPG, PNG, WEBP, GIF) ve PDF gönderilebilir' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Dosya boş' });
    let name = 'dosya'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'dosya')).slice(0, 120); } catch {}
    const id = newId(24);
    await pool.query("INSERT INTO files (id, name, type, size, data, uploaded_by, scope) VALUES ($1,$2,$3,$4,$5,$6,'chat')", [id, name, type, req.body.length, req.body, req.user.id]);
    res.json({ id, name, type, size: req.body.length });
  }));

  /* ---------------- sesli / görüntülü arama ---------------- */
  function iceServers() {
    const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const urls = String(process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length) list.push({ urls, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    return list;
  }
  const clientOf = (req, cid) => { for (const c of clients) if (c.cid === cid && c.user.id === req.user.id) return c; return null; };
  function voiceRoomOk(user, room) { if (room.startsWith('call_')) return canAccess(user, room); const c = chans.get(room); return !!c && c.kind === 'voice' && audienceOk(user, c.audience); }
  app.post('/api/call/join', json, wrap(auth), (req, res) => {
    const { room, cid } = req.body || {};
    if (typeof room !== 'string' || !voiceRoomOk(req.user, room)) return res.status(403).json({ error: 'Bu odaya giremezsiniz' });
    if (!clientOf(req, cid)) return res.status(400).json({ error: 'Bağlantı bulunamadı, sayfayı yenileyin' });
    for (const [r, m] of rooms) if (r !== room && m.has(cid)) leaveRoom(r, cid);
    const m = rooms.get(room) || new Map(); rooms.set(room, m);
    if (m.size >= 8 && !m.has(cid)) return res.status(400).json({ error: 'Oda dolu (en fazla 8 kişi)' });
    const peers = [...m.values()].filter(p => p.cid !== cid);
    m.set(cid, { cid, uid: req.user.id, name: req.user.name, muted: !!req.body.muted, video: !!req.body.video, screen: false, at: Date.now() });
    voiceChanged();
    res.json({ peers, ice: iceServers() });
  });
  app.post('/api/call/leave', json, wrap(auth), (req, res) => {
    const { room, cid } = req.body || {};
    if (clientOf(req, cid)) { if (room) leaveRoom(room, cid); else for (const r of [...rooms.keys()]) leaveRoom(r, cid); voiceChanged(); }
    res.json({ ok: true });
  });
  app.post('/api/call/state', json, wrap(auth), (req, res) => {
    const { room, cid } = req.body || {};
    const p = rooms.get(room) && rooms.get(room).get(cid);
    if (p && p.uid === req.user.id) { p.muted = !!req.body.muted; p.video = !!req.body.video; p.screen = !!req.body.screen; voiceChanged(); }
    res.json({ ok: true });
  });
  app.post('/api/call/signal', express.json({ limit: '200kb' }), wrap(auth), (req, res) => {
    const { room, from, to, data } = req.body || {};
    const m = rooms.get(room);
    const me = m && m.get(from);
    if (!me || me.uid !== req.user.id || !m.has(to)) return res.status(400).json({ error: 'Görüşme bulunamadı' });
    sendToCid(to, { type: 'signal', room, from, data });
    res.json({ ok: true });
  });
  app.post('/api/call/ring', json, wrap(auth), wrap(async (req, res) => {
    const to = String((req.body || {}).to || '');
    if (!validId(to) || to === req.user.id) return res.status(400).json({ error: 'Geçersiz kişi' });
    const t = (await pool.query("SELECT id, name, role, branch FROM users WHERE id = $1 AND status = 'active'", [to])).rows[0];
    if (!t) return res.status(404).json({ error: 'Kişi bulunamadı' });
    const room = 'call_' + newId(12); const video = !!req.body.video;
    callInvites.set(room, { from: req.user.id, fromName: req.user.name, to, toName: t.name, video, at: Date.now() });
    sendToUser(to, { type: 'ring', room, from: { id: req.user.id, name: req.user.name }, video });
    pushUser(to, { title: `${req.user.name} sizi arıyor`, body: video ? 'Görüntülü arama · açmak için dokunun' : 'Sesli arama · açmak için dokunun', url: `${baseUrl(req)}/?call=${room}#sohbet`, tag: 'call-' + room });
    const online = [...clients].some(c => c.user.id === to);
    res.json({ room, online });
  }));
  app.post('/api/call/ring/end', json, wrap(auth), wrap(async (req, res) => {
    const { room, reason } = req.body || {};
    const inv = callInvites.get(room);
    if (!inv || (inv.from !== req.user.id && inv.to !== req.user.id)) return res.json({ ok: true });
    const r = ['declined', 'cancelled', 'missed', 'busy'].includes(reason) ? reason : 'cancelled';
    for (const uid of [inv.from, inv.to]) sendToUser(uid, { type: 'ring-end', room, reason: r, by: req.user.id });
    if (r === 'missed' || r === 'declined') {
      await insertMsg(dmId(inv.from, inv.to), inv.from, r === 'missed' ? (inv.video ? 'Cevapsız görüntülü arama' : 'Cevapsız arama') : 'Arama reddedildi', { kind: 'call', meta: { reason: r, video: inv.video } }).catch(() => {});
      if (r === 'missed') pushUser(inv.to, { title: `${inv.fromName} sizi aradı`, body: 'Cevapsız arama', url: `${baseUrl(req)}/?ch=${dmId(inv.from, inv.to)}#sohbet`, tag: 'call-' + room });
    }
    const m = rooms.get(room); if (!m || !m.size) callInvites.delete(room);
    res.json({ ok: true });
  }));
  app.post('/api/call/accepted', json, wrap(auth), wrap(async (req, res) => {
    const inv = callInvites.get((req.body || {}).room);
    if (!inv || inv.to !== req.user.id) return res.status(404).json({ error: 'Arama sona erdi' });
    sendToUser(inv.to, { type: 'ring-end', room: req.body.room, reason: 'answered', by: req.user.id });
    if (!inv.logged) { inv.logged = true; await insertMsg(dmId(inv.from, inv.to), inv.from, inv.video ? 'Görüntülü arama' : 'Sesli arama', { kind: 'call', meta: { reason: 'answered', video: inv.video } }).catch(() => {}); }
    res.json({ ok: true });
  }));

  /* ---------------- mini oyunlar ---------------- */
  const GAMES2 = { xox: { name: 'XOX', cells: 9 }, dorttas: { name: 'Dört Taş', cells: 42 } };
  const SOLO = new Set(['g2048', 'yilan', 'hafiza', 'adam']);
  async function gamesOn(req, res, next) {
    const st = await ctx.getSettings();
    if (st.gamesEnabled === false) return res.status(403).json({ error: 'Oyunlar yönetici tarafından kapatıldı' });
    if (st.gamesStaffOnly && req.user.role === 'satici') return res.status(403).json({ error: 'Oyunlar sadece personele açık' });
    next();
  }
  const gameOut = g => ({ id: g.id, kind: g.kind, players: g.players, state: g.state, status: g.status, winner: g.winner, at: g.updated_at, createdAt: g.created_at });
  function sendGame(g) { const o = gameOut(g); for (const p of g.players) sendToUser(p.id, { type: 'game', game: o }); }
  function lines(kind) {
    if (kind === 'xox') return [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    const L = []; const at = (r, c) => r * 7 + c;
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const cells = []; for (let k = 0; k < 4; k++) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr >= 6 || cc < 0 || cc >= 7) break; cells.push(at(rr, cc)); }
      if (cells.length === 4) L.push(cells);
    }
    return L;
  }
  const LINES = { xox: lines('xox'), dorttas: lines('dorttas') };
  function judge(kind, board) {
    for (const l of LINES[kind]) { const v = board[l[0]]; if (v && l.every(i => board[i] === v)) return { winner: v, line: l }; }
    if (board.every(Boolean)) return { draw: true };
    return null;
  }
  async function saveGame(g) {
    await pool.query('UPDATE games SET state = $1, status = $2, winner = $3, updated_at = now() WHERE id = $4', [JSON.stringify(g.state), g.status, g.winner, g.id]);
    g.updated_at = nowIso(); sendGame(g);
  }
  async function loadGame(id) { const r = (await pool.query('SELECT * FROM games WHERE id = $1', [id])).rows[0]; return r || null; }
  async function announce(g, text) { try { await insertMsg(dmId(g.players[0].id, g.players[1].id), g.players[0].id, text, { kind: 'game', meta: { game: g.id, kind: g.kind } }); } catch {} }
  app.post('/api/games/invite', json, wrap(auth), wrap(gamesOn), wrap(async (req, res) => {
    const { kind, to } = req.body || {};
    if (!GAMES2[kind]) return res.status(400).json({ error: 'Geçersiz oyun' });
    if (!validId(to) || to === req.user.id) return res.status(400).json({ error: 'Rakip seçin' });
    const t = (await pool.query("SELECT id, name FROM users WHERE id = $1 AND status = 'active'", [to])).rows[0];
    if (!t) return res.status(404).json({ error: 'Kişi bulunamadı' });
    const id = newId(12);
    const g = { id, kind, players: [{ id: req.user.id, name: req.user.name, mark: 'X' }, { id: t.id, name: t.name, mark: 'O' }], state: { board: Array(GAMES2[kind].cells).fill(null), turn: 'X', last: null }, status: 'invite', winner: null };
    await pool.query('INSERT INTO games (id, kind, players, state, status) VALUES ($1,$2,$3,$4,$5)', [id, kind, JSON.stringify(g.players), JSON.stringify(g.state), g.status]);
    g.updated_at = nowIso(); g.created_at = g.updated_at; sendGame(g);
    pushUser(t.id, { title: `${req.user.name} sizi ${GAMES2[kind].name} oynamaya çağırıyor`, body: 'Kabul etmek için dokunun', url: `${baseUrl(req)}/#oyunlar`, tag: 'game-' + id });
    res.json(gameOut(g));
  }));
  app.post('/api/games/:id/:act', json, wrap(auth), wrap(gamesOn), wrap(async (req, res) => {
    const g = await loadGame(req.params.id); if (!g) return res.status(404).json({ error: 'Oyun bulunamadı' });
    const me = g.players.find(p => p.id === req.user.id); if (!me) return res.status(403).json({ error: 'Bu oyunda değilsiniz' });
    const act = req.params.act; const other = g.players.find(p => p.id !== req.user.id);
    if (act === 'accept') { if (g.status !== 'invite' || me.mark !== 'O') return res.status(400).json({ error: 'Davet geçersiz' }); g.status = 'playing'; await saveGame(g); return res.json(gameOut(g)); }
    if (act === 'decline') { if (g.status !== 'invite') return res.status(400).json({ error: 'Davet geçersiz' }); g.status = 'declined'; await saveGame(g); return res.json(gameOut(g)); }
    if (act === 'resign') {
      if (!['playing', 'invite'].includes(g.status)) return res.status(400).json({ error: 'Oyun bitti' });
      const wasInvite = g.status === 'invite';
      g.status = wasInvite ? 'declined' : 'done'; g.winner = wasInvite ? null : other.id; g.state.resigned = me.id; await saveGame(g);
      if (!wasInvite) await announce(g, `🎮 ${GAMES2[g.kind].name}: ${me.name} pes etti, ${other.name} kazandı`);
      return res.json(gameOut(g));
    }
    if (act === 'rematch') {
      if (g.status !== 'done') return res.status(400).json({ error: 'Oyun bitmedi' });
      const id = newId(12); const players = [{ id: me.id, name: me.name, mark: 'X' }, { id: other.id, name: other.name, mark: 'O' }]; // isteyen başlar, rakip kabul eder
      const n = { id, kind: g.kind, players, state: { board: Array(GAMES2[g.kind].cells).fill(null), turn: 'X', last: null }, status: 'invite', winner: null };
      await pool.query('INSERT INTO games (id, kind, players, state, status) VALUES ($1,$2,$3,$4,$5)', [id, n.kind, JSON.stringify(n.players), JSON.stringify(n.state), n.status]);
      n.updated_at = nowIso(); n.created_at = n.updated_at; sendGame(n); return res.json(gameOut(n));
    }
    if (act !== 'move') return res.status(400).json({ error: 'Geçersiz işlem' });
    if (g.status !== 'playing') return res.status(400).json({ error: 'Oyun devam etmiyor' });
    if (g.state.turn !== me.mark) return res.status(400).json({ error: 'Sıra sizde değil' });
    const b = g.state.board; let i = Number((req.body || {}).i);
    if (g.kind === 'dorttas') { const col = i; if (!(col >= 0 && col < 7)) return res.status(400).json({ error: 'Geçersiz hamle' }); i = -1; for (let r = 5; r >= 0; r--) if (!b[r * 7 + col]) { i = r * 7 + col; break; } if (i < 0) return res.status(400).json({ error: 'Bu sütun dolu' }); }
    else if (!(i >= 0 && i < 9) || b[i]) return res.status(400).json({ error: 'Geçersiz hamle' });
    b[i] = me.mark; g.state.last = i; g.state.turn = me.mark === 'X' ? 'O' : 'X';
    const j = judge(g.kind, b);
    if (j) { g.status = 'done'; g.winner = j.winner ? me.id : null; g.state.line = j.line || null; }
    await saveGame(g);
    if (j) await announce(g, j.winner ? `🎮 ${GAMES2[g.kind].name}: ${me.name}, ${other.name} karşısında kazandı 🏆` : `🎮 ${GAMES2[g.kind].name}: ${me.name} ve ${other.name} berabere kaldı`);
    else pushUser(other.id, { title: `${GAMES2[g.kind].name}: sıra sizde`, body: `${me.name} hamlesini yaptı`, url: `${baseUrl(req)}/#oyunlar`, tag: 'game-' + g.id });
    res.json(gameOut(g));
  }));
  app.get('/api/games/state', wrap(auth), wrap(async (req, res) => {
    const st = await ctx.getSettings();
    const enabled = st.gamesEnabled !== false && !(st.gamesStaffOnly && req.user.role === 'satici');
    const [mine, board, wins, mybest] = await Promise.all([
      pool.query("SELECT * FROM games WHERE players @> $1::jsonb AND (status IN ('invite','playing') OR updated_at > now() - interval '2 days') ORDER BY updated_at DESC LIMIT 30", [JSON.stringify([{ id: req.user.id }])]),
      pool.query(`SELECT game, user_id, name, best FROM (SELECT s.game, s.user_id, u.name, max(s.score) AS best, row_number() OVER (PARTITION BY s.game ORDER BY max(s.score) DESC) AS rn
        FROM game_scores s JOIN users u ON u.id = s.user_id GROUP BY s.game, s.user_id, u.name) x WHERE rn <= 10 ORDER BY game, best DESC`),
      pool.query(`SELECT g.kind, g.winner AS user_id, u.name, count(*)::int AS n FROM games g JOIN users u ON u.id = g.winner WHERE g.status = 'done' AND g.winner IS NOT NULL GROUP BY g.kind, g.winner, u.name ORDER BY n DESC`),
      pool.query('SELECT game, max(score)::int AS best FROM game_scores WHERE user_id = $1 GROUP BY game', [req.user.id]),
    ]);
    const lb = {}; for (const r of board.rows) (lb[r.game] = lb[r.game] || []).push({ uid: r.user_id, name: r.name, score: Number(r.best) });
    const wb = {}; for (const r of wins.rows) (wb[r.kind] = wb[r.kind] || []).push({ uid: r.user_id, name: r.name, wins: r.n });
    res.json({ enabled, games: mine.rows.map(gameOut), leaderboard: lb, wins: wb, best: Object.fromEntries(mybest.rows.map(r => [r.game, r.best])) });
  }));
  app.post('/api/games/score', json, wrap(auth), wrap(gamesOn), wrap(async (req, res) => {
    const { game } = req.body || {}; const score = Math.round(Number((req.body || {}).score));
    if (!SOLO.has(game) || !(score > 0 && score < 10000000)) return res.status(400).json({ error: 'Geçersiz skor' });
    const prev = (await pool.query('SELECT max(score)::int AS b FROM game_scores WHERE game = $1 AND user_id = $2', [game, req.user.id])).rows[0].b || 0;
    const top = (await pool.query('SELECT max(score)::int AS b FROM game_scores WHERE game = $1', [game])).rows[0].b || 0;
    await pool.query('INSERT INTO game_scores (game, user_id, score) VALUES ($1,$2,$3)', [game, req.user.id, score]);
    await pool.query("DELETE FROM game_scores WHERE id IN (SELECT id FROM game_scores WHERE game = $1 AND user_id = $2 ORDER BY score DESC OFFSET 20)", [game, req.user.id]);
    res.json({ ok: true, personalBest: score > prev, record: score > top });
  }));

  return { migrate, onConnect, onDisconnect, canSee, sendToUser };
};
