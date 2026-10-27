'use strict';
/*
 * Ümraniye Şampiyonları — çevrimiçi oyun masaları (Pişti, 101 Okey, Tavla)
 * Masalar bellekte tutulur, her değişiklikte "games" tablosuna yazılır. Gizli bilgiler (eller, deste)
 * hiçbir zaman istemciye gitmez; her oyuncuya yalnızca kendi görebileceği görünüm gönderilir.
 */
module.exports = function setupTables(ctx) {
  const { app, pool, express, wrap, auth, newId, clients, pushUser, baseUrl, validId, getSettings } = ctx;
  const json = express.json({ limit: '40kb' });
  const ENGINES = {};
  const TABLES = new Map();
  const BOT_NAMES = ['Ayla (bot)', 'Cem (bot)', 'Deniz (bot)', 'Ece (bot)', 'Kaan (bot)', 'Lale (bot)'];
  const now = () => Date.now();
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const write = (c, evt) => { try { c.res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { clients.delete(c); } };
  const isBot = s => !!(s && s.bot);
  const humans = t => t.seats.filter(s => s && !s.bot);

  /* ---------------- kalıcılık ---------------- */
  async function persist(t) {
    t._chain = (t._chain || Promise.resolve()).then(() => pool.query(
      `INSERT INTO games (id, kind, players, state, status, winner, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), now())
       ON CONFLICT (id) DO UPDATE SET players = EXCLUDED.players, state = EXCLUDED.state, status = EXCLUDED.status, winner = EXCLUDED.winner, updated_at = now()`,
      [t.id, t.kind, JSON.stringify(t.seats.map(s => s && { id: s.id, name: s.name, bot: !!s.bot })), JSON.stringify(stored(t)), t.status, t.winner || null, t.createdAt])).catch(e => console.warn('Masa kaydedilemedi', e.message));
    return t._chain;
  }
  const stored = t => ({ table: { host: t.host, options: t.options, seats: t.seats, status: t.status, createdAt: t.createdAt, emotes: [] }, game: t.game, result: t.result || null });
  async function restore() {
    const { rows } = await pool.query("SELECT * FROM games WHERE kind = ANY($1) AND status IN ('open','playing') AND updated_at > now() - interval '2 days'", [Object.keys(ENGINES)]);
    for (const r of rows) {
      const st = r.state || {}; const tb = st.table || {};
      const t = { id: r.id, kind: r.kind, host: tb.host, options: tb.options || {}, seats: tb.seats || r.players, status: r.status, createdAt: tb.createdAt || Date.parse(r.created_at), game: st.game || null, result: st.result || null };
      TABLES.set(t.id, t);
      if (t.status === 'playing') schedule(t);
    }
    if (rows.length) console.log('Oyun masaları geri yüklendi:', rows.length);
  }

  /* ---------------- dağıtım ---------------- */
  function summary(t) {
    return { id: t.id, kind: t.kind, name: ENGINES[t.kind].name, status: t.status, host: t.host, options: t.options, createdAt: t.createdAt,
      seats: t.seats.map(s => s && { id: s.id, name: s.name, bot: !!s.bot, away: !!s.away }), turn: t.game ? ENGINES[t.kind].turnSeat(t) : null };
  }
  function viewFor(t, uid) {
    const seat = t.seats.findIndex(s => s && s.id === uid);
    const base = { ...summary(t), me: seat, deadline: t.deadline || null, result: t.result || null, emote: t.lastEmote || null, note: t.lastNote || null, now: now() };
    if (t.game) base.game = ENGINES[t.kind].view(t, seat);
    return base;
  }
  function watchers(t) { return new Set([...t.seats.filter(s => s && !s.bot).map(s => s.id), ...(t.spect || [])]); }
  function push(t) {
    const ids = watchers(t);
    for (const c of clients) if (ids.has(c.user.id)) write(c, { type: 'table', table: viewFor(t, c.user.id) });
    lobby();
  }
  let lobT = null;
  function lobby() { clearTimeout(lobT); lobT = setTimeout(() => { const list = [...TABLES.values()].filter(t => t.status !== 'done' && t.status !== 'cancelled').map(summary); for (const c of clients) write(c, { type: 'tables', tables: list }); }, 250); }

  /* ---------------- tur zamanlayıcı ve botlar ---------------- */
  function schedule(t) {
    clearTimeout(t.timer); t.deadline = null;
    if (t.status !== 'playing' || !t.game) return;
    const E = ENGINES[t.kind];
    if (E.isOver(t)) return finish(t);
    if (E.between && E.between(t)) { t.timer = setTimeout(() => { E.nextHand(t); afterChange(t); }, 4500); return; }
    const seat = E.turnSeat(t); if (seat == null) return;
    const s = t.seats[seat];
    if (isBot(s) || (s && s.away)) { t.timer = setTimeout(() => botMove(t, seat), E.botDelay ? E.botDelay(t) : 1100 + Math.random() * 900); return; }
    const limit = (E.timeLimit || 40) * 1000; t.deadline = now() + limit;
    t.timer = setTimeout(() => { const st = t.seats[seat]; if (st) { st.timeouts = (st.timeouts || 0) + 1; if (st.timeouts >= 3) st.away = true; } botMove(t, seat, true); }, limit + 400);
  }
  function botMove(t, seat, timeout) {
    if (t.status !== 'playing') return;
    const E = ENGINES[t.kind]; if (E.turnSeat(t) !== seat) return schedule(t);
    let guard = 0;
    while (E.turnSeat(t) === seat && guard++ < 30 && t.status === 'playing') {
      const a = E.bot(t, seat); if (!a) break;
      const r = E.act(t, seat, a); if (r && r.error) { console.warn('Bot hamlesi reddedildi', t.kind, a.type, r.error); const f = E.fallback && E.fallback(t, seat); if (!f) break; const r2 = E.act(t, seat, f); if (r2 && r2.error) break; }
      if (E.stepwise) break;
    }
    if (timeout) t.lastNote = { seat, text: `${(t.seats[seat] || {}).name || 'Oyuncu'}: süre doldu, otomatik oynandı`, at: now() };
    afterChange(t);
  }
  function afterChange(t) { const E = ENGINES[t.kind]; if (t.game && E.isOver(t)) return finish(t); schedule(t); persist(t); push(t); }
  function finish(t) {
    clearTimeout(t.timer); t.deadline = null;
    const E = ENGINES[t.kind]; const res = E.result(t);
    t.status = 'done'; t.result = res; t.winner = res.ranking && res.ranking.length ? res.ranking[0] : null;
    if (res.draw) t.winner = null;
    persist(t); push(t);
    const hs = humans(t);
    for (const h of hs) pushUser(h.id, { kind: 'game', title: `${E.name} bitti`, body: res.draw ? 'Berabere' : (t.winner === h.id ? 'Kazandınız! 🏆' : `${(t.seats.find(s => s && s.id === t.winner) || {}).name || ''} kazandı`), url: `${ctx.appUrl()}/#oyunlar`, tag: 'table-' + t.id }, { ttl: 3600 });
    setTimeout(() => { if (TABLES.get(t.id) === t) TABLES.delete(t.id); lobby(); }, 30 * 60e3);
  }

  /* ---------------- uçlar ---------------- */
  async function gamesOn(req, res, next) {
    const st = await getSettings();
    if (st.gamesEnabled === false) return res.status(403).json({ error: 'Oyunlar yönetici tarafından kapatıldı' });
    if (st.gamesStaffOnly && req.user.role === 'satici') return res.status(403).json({ error: 'Oyunlar sadece personele açık' });
    next();
  }
  const getT = (req, res) => { const t = TABLES.get(req.params.id); if (!t) { res.status(404).json({ error: 'Masa bulunamadı veya kapandı' }); return null; } return t; };
  const meSeat = (t, uid) => t.seats.findIndex(s => s && s.id === uid);
  app.get('/api/tables', wrap(auth), (req, res) => {
    const list = [...TABLES.values()].filter(t => t.status !== 'done' && t.status !== 'cancelled').map(summary);
    const mine = [...TABLES.values()].filter(t => meSeat(t, req.user.id) >= 0).map(t => viewFor(t, req.user.id));
    res.json({ tables: list, mine, kinds: Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, { name: e.name, seats: e.seats, options: e.optionsSpec }])) });
  });
  app.get('/api/tables/:id', wrap(auth), (req, res) => { const t = getT(req, res); if (!t) return; if (meSeat(t, req.user.id) < 0) { t.spect = [...new Set([...(t.spect || []), req.user.id])].slice(-20); } res.json(viewFor(t, req.user.id)); });
  app.post('/api/tables', json, wrap(auth), wrap(gamesOn), (req, res) => {
    const { kind } = req.body || {}; const E = ENGINES[kind];
    if (!E) return res.status(400).json({ error: 'Geçersiz oyun' });
    for (const t of TABLES.values()) if (t.status === 'open' && meSeat(t, req.user.id) >= 0) return res.status(400).json({ error: 'Zaten bekleyen bir masanız var' });
    const options = E.options(req.body.options || {});
    const n = options.seats || E.seats[0];
    const t = { id: newId(12), kind, host: req.user.id, options, seats: Array(n).fill(null), status: 'open', createdAt: now(), game: null };
    t.seats[0] = { id: req.user.id, name: req.user.name };
    TABLES.set(t.id, t); persist(t); push(t);
    res.json(viewFor(t, req.user.id));
  });
  app.post('/api/tables/:id/:act', json, wrap(auth), wrap(gamesOn), wrap(async (req, res) => {
    const t = getT(req, res); if (!t) return;
    const u = req.user; const act = req.params.act; const seat = meSeat(t, u.id); const E = ENGINES[t.kind];
    if (act === 'join') {
      if (t.status !== 'open') return res.status(400).json({ error: 'Oyun başladı, sadece izleyebilirsiniz' });
      if (seat >= 0) return res.json(viewFor(t, u.id));
      let want = Number.isInteger(req.body.seat) ? req.body.seat : t.seats.findIndex(s => !s || s.bot);
      if (!(want >= 0 && want < t.seats.length) || (t.seats[want] && !t.seats[want].bot)) want = t.seats.findIndex(s => !s || s.bot);
      if (want < 0) return res.status(400).json({ error: 'Masa dolu' });
      t.seats[want] = { id: u.id, name: u.name }; persist(t); push(t); return res.json(viewFor(t, u.id));
    }
    if (act === 'leave') {
      if (seat < 0) return res.json({ ok: true });
      if (t.status === 'open') {
        if (t.host === u.id) { t.status = 'cancelled'; clearTimeout(t.timer); persist(t); push(t); TABLES.delete(t.id); lobby(); return res.json({ ok: true }); }
        t.seats[seat] = null; persist(t); push(t); return res.json({ ok: true });
      }
      if (t.status === 'playing') {
        const bn = BOT_NAMES[seat % BOT_NAMES.length];
        t.seats[seat] = { id: 'bot_' + newId(6), name: bn.replace(' (bot)', '') + ' (bot, ' + u.name + ' yerine)', bot: true, replaced: u.id };
        t.lastNote = { seat, text: `${u.name} masadan ayrıldı, yerine bot oynuyor`, at: now() };
        if (!humans(t).length) { t.status = 'cancelled'; clearTimeout(t.timer); persist(t); push(t); TABLES.delete(t.id); lobby(); return res.json({ ok: true }); }
        afterChange(t); return res.json({ ok: true });
      }
      return res.json({ ok: true });
    }
    if (act === 'bots') {
      if (t.host !== u.id || t.status !== 'open') return res.status(403).json({ error: 'Botları masa sahibi ekleyebilir' });
      let k = 0; t.seats = t.seats.map((s, i) => s || { id: 'bot_' + newId(6), name: BOT_NAMES[(i + k++) % BOT_NAMES.length], bot: true });
      persist(t); push(t); return res.json(viewFor(t, u.id));
    }
    if (act === 'kick') {
      const i = Number(req.body.seat);
      if (t.host !== u.id || t.status !== 'open' || !(i > 0 && i < t.seats.length)) return res.status(403).json({ error: 'Yetkiniz yok' });
      t.seats[i] = null; persist(t); push(t); return res.json(viewFor(t, u.id));
    }
    if (act === 'start') {
      if (t.host !== u.id || t.status !== 'open') return res.status(403).json({ error: 'Oyunu masa sahibi başlatır' });
      if (t.seats.some(s => !s)) return res.status(400).json({ error: 'Boş koltuk var; oyuncu bekleyin veya botlarla doldurun' });
      t.status = 'playing'; t.game = E.init(t); t.startedAt = now(); afterChange(t);
      for (const h of humans(t)) if (h.id !== u.id) pushUser(h.id, { kind: 'game', title: `${E.name} başladı`, body: `${u.name} oyunu başlattı · masaya dönün`, url: `${baseUrl(req)}/?masa=${t.id}#oyunlar`, tag: 'table-' + t.id }, { ttl: 600 });
      return res.json(viewFor(t, u.id));
    }
    if (act === 'invite') {
      const to = String(req.body.to || '');
      if (seat < 0 || !validId(to)) return res.status(400).json({ error: 'Geçersiz davet' });
      for (const c of clients) if (c.user.id === to) write(c, { type: 'table-invite', table: summary(t), from: { id: u.id, name: u.name } });
      const n = await pushUser(to, { kind: 'game', title: `${u.name} sizi ${E.name} masasına çağırıyor`, body: 'Masaya oturmak için dokunun', url: `${baseUrl(req)}/?masa=${t.id}#oyunlar`, tag: 'table-' + t.id }, { ttl: 1800 });
      return res.json({ ok: true, devices: n });
    }
    if (act === 'emote') {
      const e = String(req.body.e || '').slice(0, 40);
      const OK = ['👏 Helal!', '😂', '😮 Vay be', '🔥 Bu el benim', '🤝 İyi oyun', '😅 Şans', '⏰ Hadi!', '🙈 Olamaz'];
      if (seat < 0 || !OK.includes(e)) return res.status(400).json({ error: 'Geçersiz' });
      if (now() - (t.seats[seat].emoAt || 0) < 2500) return res.json({ ok: true });
      t.seats[seat].emoAt = now(); t.lastEmote = { seat, e, at: now() }; push(t); return res.json({ ok: true });
    }
    if (act === 'back') { if (seat >= 0 && t.seats[seat]) { t.seats[seat].away = false; t.seats[seat].timeouts = 0; push(t); } return res.json({ ok: true }); }
    if (act === 'act') {
      if (t.status !== 'playing') return res.status(400).json({ error: 'Oyun devam etmiyor' });
      if (seat < 0) return res.status(403).json({ error: 'Bu masada oyuncu değilsiniz' });
      const s = t.seats[seat]; s.timeouts = 0; s.away = false;
      const r = E.act(t, seat, req.body || {});
      if (r && r.error) return res.status(400).json({ error: r.error });
      afterChange(t);
      return res.json(viewFor(t, u.id));
    }
    res.status(400).json({ error: 'Geçersiz işlem' });
  }));

  /* ================= PİŞTİ ================= */
  const SUITS = ['S', 'H', 'D', 'C'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const rk = c => c.slice(1), su = c => c[0];
  const cardVal = c => (rk(c) === 'A' ? 1 : 0) + (rk(c) === 'J' ? 1 : 0) + (c === 'C2' ? 2 : 0) + (c === 'D10' ? 3 : 0);
  ENGINES.pisti = {
    name: 'Pişti', seats: [2, 4], timeLimit: 30, optionsSpec: { seats: [2, 4], target: [0, 51, 101, 151] },
    options: o => ({ seats: [2, 4].includes(Number(o.seats)) ? Number(o.seats) : 2, target: [0, 51, 101, 151].includes(Number(o.target)) ? Number(o.target) : 101 }),
    init(t) { const g = { hand: 0, totals: Array(t.seats.length).fill(0), dealer: Math.floor(Math.random() * t.seats.length), history: [] }; this.deal(t, g); return g; },
    deal(t, g) {
      const n = t.seats.length; g.hand++;
      g.deck = shuffle(SUITS.flatMap(s => RANKS.map(r => s + r)));
      g.pile = g.deck.splice(0, 4); g.hidden = 3;
      g.hands = Array.from({ length: n }, () => []); g.captured = Array.from({ length: n }, () => []); g.pistis = Array.from({ length: n }, () => []);
      g.turn = (g.dealer + 1) % n; g.lastCap = null; g.played = [g.pile[3]]; g.last = null; g.round = 0; g.handOver = false; g.handScores = null;
      this.refill(g, n);
    },
    refill(g, n) { if (!g.deck.length) return false; for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) { const s = (g.turn + i) % n; if (g.deck.length) g.hands[s].push(g.deck.shift()); } g.round++; return true; },
    turnSeat(t) { const g = t.game; return g && !g.handOver ? g.turn : null; },
    between(t) { return !!(t.game && t.game.handOver && !this.isOver(t)); },
    isOver(t) { const g = t.game; if (!g || !g.handOver) return false; const tg = t.options.target; if (!tg) return true; const mx = Math.max(...g.totals); return mx >= tg && g.totals.filter(x => x === mx).length === 1; },
    act(t, seat, a) {
      const g = t.game; const n = t.seats.length;
      if (a.type !== 'play') return { error: 'Geçersiz hamle' };
      if (g.handOver || g.turn !== seat) return { error: 'Sıra sizde değil' };
      const i = g.hands[seat].indexOf(a.card); if (i < 0) return { error: 'Bu kart elinizde yok' };
      const card = g.hands[seat].splice(i, 1)[0]; g.played.push(card);
      const top = g.pile[g.pile.length - 1];
      let cap = false, pisti = 0;
      if (top && (rk(card) === rk(top) || rk(card) === 'J')) {
        cap = true;
        if (g.pile.length === 1 && rk(card) === rk(top)) { pisti = rk(card) === 'J' ? 20 : 10; g.pistis[seat].push({ card, pts: pisti }); }
        g.captured[seat].push(...g.pile, card); g.pile = []; g.hidden = 0; g.lastCap = seat;
      } else g.pile.push(card);
      g.last = { seat, card, cap, pisti, top: top || null, at: now() };
      g.turn = (seat + 1) % n;
      if (g.hands.every(h => !h.length)) { if (!this.refill(g, n)) this.endHand(t); }
      return { ok: true };
    },
    endHand(t) {
      const g = t.game; const n = t.seats.length;
      if (g.pile.length && g.lastCap != null) { g.captured[g.lastCap].push(...g.pile); g.pile = []; }
      const counts = g.captured.map(c => c.length); const mx = Math.max(...counts); const leaders = counts.filter(x => x === mx).length;
      g.handScores = g.captured.map((c, i) => {
        const cards = c.reduce((a, x) => a + cardVal(x), 0); const pis = g.pistis[i].reduce((a, p) => a + p.pts, 0); const most = counts[i] === mx && leaders === 1 ? 3 : 0;
        return { cards, pisti: pis, most, total: cards + pis + most, count: counts[i], aces: c.filter(x => rk(x) === 'A').length, jacks: c.filter(x => rk(x) === 'J').length, c2: c.includes('C2'), d10: c.includes('D10') };
      });
      g.handScores.forEach((h, i) => { g.totals[i] += h.total; });
      g.history.push(g.handScores.map(h => h.total));
      g.handOver = true; g.turn = null;
    },
    nextHand(t) { const g = t.game; g.dealer = (g.dealer + 1) % t.seats.length; this.deal(t, g); },
    result(t) {
      const g = t.game; const order = g.totals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
      const draw = order.length > 1 && order[0][0] === order[1][0];
      return { ranking: order.map(([, i]) => t.seats[i].id), totals: g.totals, draw, history: g.history };
    },
    view(t, seat) {
      const g = t.game; const n = t.seats.length;
      return { hand: g.hand, round: g.round, target: t.options.target, totals: g.totals, dealer: g.dealer, turn: g.turn, deck: g.deck.length,
        pile: { count: g.pile.length, hidden: g.hidden, cards: g.pile.slice(Math.max(g.hidden, g.pile.length - 6)) },
        my: seat >= 0 ? g.hands[seat] : [], counts: g.hands.map(h => h.length),
        captured: g.captured.map(c => c.length), pistis: g.pistis.map(p => p.map(x => x.pts)), last: g.last, lastCap: g.lastCap,
        handOver: g.handOver, handScores: g.handScores, history: g.history, live: g.captured.map((c, i) => c.reduce((a, x) => a + cardVal(x), 0) + g.pistis[i].reduce((a, p) => a + p.pts, 0)) };
    },
    bot(t, seat) {
      const g = t.game; const h = g.hands[seat]; if (!h.length) return null;
      const top = g.pile[g.pile.length - 1]; const pileVal = g.pile.reduce((a, c) => a + cardVal(c), 0) + g.pile.length * 0.15;
      const seen = {}; for (const c of g.played) seen[rk(c)] = (seen[rk(c)] || 0) + 1; for (const c of h) seen[rk(c)] = (seen[rk(c)] || 0) + 1;
      const risk = c => 4 - (seen[rk(c)] || 0); // rakipte aynı sayıdan kaç tane olabilir
      const keepVal = c => cardVal(c) * 3 + (rk(c) === 'J' ? 6 : 0);
      if (top) {
        const match = h.filter(c => rk(c) === rk(top) && rk(c) !== 'J');
        if (match.length && (g.pile.length === 1 || pileVal >= 0.4)) return { type: 'play', card: match.sort((a, b) => cardVal(a) - cardVal(b))[0] };
        const jack = h.find(c => rk(c) === 'J');
        if (rk(top) === 'J' && jack && g.pile.length === 1) return { type: 'play', card: jack };
        if (jack && (pileVal >= 1.2 || g.pile.length >= 4 || (!g.deck.length && h.length === 1))) return { type: 'play', card: jack };
        if (match.length) return { type: 'play', card: match[0] };
      }
      const cand = h.filter(c => rk(c) !== 'J'); const pool2 = cand.length ? cand : h;
      return { type: 'play', card: pool2.sort((a, b) => (risk(a) * 2 + keepVal(a)) - (risk(b) * 2 + keepVal(b)))[0] };
    },
  };

  /* dış motorları kaydet (okey, tavla) */
  function register(kind, engine) { ENGINES[kind] = engine; }
  return { ENGINES, register, restore, lobby, TABLES, helpers: { shuffle, now } };
};
