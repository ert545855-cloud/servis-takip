'use strict';
/* Tavla motoru (2 kişi). Klasik tavla: zar, kırma, bar, toplama; mars 2 puan; maç belirlenen puana kadar. */
module.exports = function tavlaEngine({ now }) {
  const die = () => 1 + Math.floor(Math.random() * 6);
  const sg = s => (s === 0 ? 1 : -1);
  const rOf = (s, p) => (s === 0 ? p : 25 - p);   // oyuncunun bakışıyla kalan mesafe (1..24)
  const pOf = (s, r) => (s === 0 ? r : 25 - r);
  const own = (st, s, p) => Math.max(0, st.board[p] * sg(s));
  const opp = (st, s, p) => Math.max(0, -st.board[p] * sg(s));
  const clone = st => ({ board: st.board.slice(), bar: st.bar.slice(), off: st.off.slice() });
  function start() {
    const b = Array(26).fill(0);
    b[24] = 2; b[13] = 5; b[8] = 3; b[6] = 5;      // beyaz (0): 24'ten 1'e
    b[1] = -2; b[12] = -5; b[17] = -3; b[19] = -5; // kırmızı (1): 1'den 24'e
    return { board: b, bar: [0, 0], off: [0, 0] };
  }
  function allHome(st, s) { if (st.bar[s]) return false; for (let p = 1; p <= 24; p++) if (own(st, s, p) && rOf(s, p) > 6) return false; return true; }
  function singles(st, s, d) {
    const out = [];
    if (st.bar[s]) { const to = pOf(s, 25 - d); if (opp(st, s, to) < 2) out.push({ from: 'bar', to, d }); return out; }
    const home = allHome(st, s);
    for (let p = 1; p <= 24; p++) {
      if (!own(st, s, p)) continue;
      const r = rOf(s, p); const rt = r - d;
      if (rt >= 1) { const to = pOf(s, rt); if (opp(st, s, to) < 2) out.push({ from: p, to, d }); }
      else if (home) {
        if (rt === 0) out.push({ from: p, to: 'off', d });
        else { let higher = false; for (let r2 = r + 1; r2 <= 6; r2++) if (own(st, s, pOf(s, r2))) { higher = true; break; } if (!higher) out.push({ from: p, to: 'off', d }); }
      }
    }
    return out;
  }
  function apply(st, s, m) {
    const n = clone(st); const g = sg(s); let hit = false;
    if (m.from === 'bar') n.bar[s]--; else n.board[m.from] -= g;
    if (m.to === 'off') n.off[s]++;
    else { if (n.board[m.to] === -g) { n.board[m.to] = 0; n.bar[1 - s]++; hit = true; } n.board[m.to] += g; }
    return { st: n, hit };
  }
  // azami zar kullanımı kuralı: önce en uzun hamle dizisinin boyu bulunur
  const keyOf = (st, left) => st.board.join(',') + '|' + st.bar.join(',') + '|' + st.off.join(',') + '|' + left.join(',');
  const without = (a, i) => a.slice(0, i).concat(a.slice(i + 1));
  function analyze(st, s, dice) {
    const memo = new Map();
    const depth = (cur, left) => {
      const k = keyOf(cur, left); if (memo.has(k)) return memo.get(k);
      let best = 0; const tried = new Set();
      outer: for (let i = 0; i < left.length; i++) {
        const d = left[i]; if (tried.has(d)) continue; tried.add(d);
        for (const m of singles(cur, s, d)) { const a = apply(cur, s, m); const v = a.st.off[s] === 15 ? left.length : 1 + depth(a.st, without(left, i)); if (v > best) best = v; if (best === left.length) break outer; }
      }
      memo.set(k, best); return best;
    };
    return { max: depth(st, dice), depth };
  }
  function firstMoves(st, s, dice) {
    const { max, depth } = analyze(st, s, dice); if (!max) return [];
    const out = []; const tried = new Set();
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i]; if (tried.has(d)) continue; tried.add(d);
      for (const m of singles(st, s, d)) { const a = apply(st, s, m); if ((a.st.off[s] === 15 ? dice.length : 1 + depth(a.st, without(dice, i))) === max) out.push(m); }
    }
    if (max === 1 && dice.length === 2 && dice[0] !== dice[1]) { const hi = Math.max(...dice); if (out.some(m => m.d === hi)) return out.filter(m => m.d === hi); }
    return out;
  }
  function finals(st, s, dice) {
    const { max } = analyze(st, s, dice); const out = new Map(); const seen = new Set();
    const rec = (cur, left, path) => {
      if (path.length === max || (path.length && cur.off[s] === 15)) { const k = keyOf(cur, []); if (!out.has(k)) out.set(k, { st: cur, path }); return; }
      const k = keyOf(cur, left); if (seen.has(k)) return; seen.add(k);
      const tried = new Set();
      for (let i = 0; i < left.length; i++) { const d = left[i]; if (tried.has(d)) continue; tried.add(d);
        for (const m of singles(cur, s, d)) { const a = apply(cur, s, m); rec(a.st, without(left, i), path.concat([{ ...m, hit: a.hit }])); } }
    };
    rec(st, dice, []);
    let res = [...out.values()];
    if (max === 1 && dice.length === 2 && dice[0] !== dice[1]) { const hi = Math.max(...dice); const big = res.filter(r => r.path[0].d === hi); if (big.length) res = big; }
    return res;
  }
  const pip = (st, s) => { let x = st.bar[s] * 25; for (let p = 1; p <= 24; p++) x += own(st, s, p) * rOf(s, p); return x; };
  function evaluate(st, s) {
    const o = 1 - s; let sc = 0;
    sc += (pip(st, o) - pip(st, s)) * 1.0;
    sc += st.off[s] * 12 - st.off[o] * 12;
    sc += st.bar[o] * 18 - st.bar[s] * 22;
    // tehlike: rakibin önündeki açık pullar
    let oppBehind = st.bar[o] > 0; let made = 0, prime = 0, run = 0;
    for (let r = 24; r >= 1; r--) {
      const p = pOf(s, r); const c = own(st, s, p); const oc = opp(st, s, p);
      if (oc) oppBehind = oppBehind || true;
      if (c === 1) { // rakip bu pulun gerisinde mi?
        let threat = st.bar[o] > 0; for (let r2 = r - 1; r2 >= 1 && !threat; r2--) if (opp(st, s, pOf(s, r2))) threat = true;
        if (threat) sc -= 7 + (r <= 6 ? 4 : 0) + (r > 18 ? -3 : 0);
      }
      if (c >= 2) { made++; sc += 3 + (r <= 6 ? 4 : 0) + (r === 5 || r === 7 ? 2 : 0); run++; if (run >= 3) prime += run; } else run = 0;
      if (c > 4) sc -= (c - 4) * 1.5;
    }
    sc += prime * 1.2;
    return sc;
  }
  const E = {
    name: 'Tavla', seats: [2], timeLimit: 45, betweenMs: 5500, optionsSpec: { target: [1, 3, 5, 7] },
    options: o => ({ seats: 2, target: [1, 3, 5, 7].includes(Number(o.target)) ? Number(o.target) : 5 }),
    botDelay: () => 900 + Math.random() * 700,
    init(t) { const g = { game: 0, totals: [0, 0], history: [], first: Math.floor(Math.random() * 2) }; this.newGame(t, g, g.first); return g; },
    newGame(t, g, first) {
      g.game++; Object.assign(g, start()); g.turn = first; g.phase = 'roll'; g.dice = null; g.left = []; g.moves = []; g.stack = [];
      g.handOver = false; g.handScores = null; g.log = g.log || []; g.last = null; g.winner = null;
      this.log(t, first, `${g.game}. oyun başladı, ilk zarı ${this.nm(t, first)} atıyor`, g);
    },
    nm: (t, s) => (t.seats[s] ? t.seats[s].name : 'Oyuncu'),
    log(t, s, text, gg) { const g = gg || t.game; g.log.push({ seat: s, text, at: now() }); if (g.log.length > 30) g.log.splice(0, g.log.length - 30); },
    turnSeat(t) { const g = t.game; return g && !g.handOver ? g.turn : null; },
    between(t) { return !!(t.game && t.game.handOver && !this.isOver(t)); },
    isOver(t) { const g = t.game; return !!(g && g.handOver && Math.max(...g.totals) >= t.options.target); },
    legal(g, s) { if (g.phase !== 'move') return []; const m = new Map(); for (const f of firstMoves(g, s, g.left)) { const k = f.from + '>' + f.to; if (!m.has(k) || f.d < m.get(k).d) m.set(k, { from: f.from, to: f.to, d: f.d }); } return [...m.values()]; },
    act(t, seat, a) {
      const g = t.game; if (g.handOver) return { error: 'Oyun bitti' };
      if (g.turn !== seat) return { error: 'Sıra sizde değil' };
      const type = a && a.type;
      if (type === 'roll') {
        if (g.phase !== 'roll') return { error: 'Zar zaten atıldı' };
        const d1 = die(), d2 = die(); g.dice = [d1, d2]; g.left = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2]; g.moves = []; g.stack = [];
        g.last = { seat, type: 'roll', dice: g.dice, at: now() };
        const { max } = analyze(g, seat, g.left);
        if (!max) { this.log(t, seat, `${this.nm(t, seat)} ${d1}-${d2} attı, oynayacak hamlesi yok`); g.left = []; this.pass(t, seat); return { ok: true }; }
        g.phase = 'move'; this.log(t, seat, `${this.nm(t, seat)} ${d1}-${d2} attı${d1 === d2 ? ' (çift!)' : ''}`);
        return { ok: true };
      }
      if (type === 'move') {
        if (g.phase !== 'move') return { error: g.phase === 'roll' ? 'Önce zar atın' : 'Hamleleriniz bitti, onaylayın' };
        const from = a.from === 'bar' ? 'bar' : Number(a.from); const to = a.to === 'off' ? 'off' : Number(a.to);
        const L = this.legal(g, seat).filter(m => m.from === from && m.to === to);
        if (!L.length) return { error: 'Bu hamle kurallara uygun değil' };
        const m = L[0];
        g.stack.push({ board: g.board.slice(), bar: g.bar.slice(), off: g.off.slice(), left: g.left.slice(), moves: g.moves.slice() });
        const r = apply(g, seat, m); Object.assign(g, r.st);
        g.left.splice(g.left.indexOf(m.d), 1); g.moves.push({ from, to, d: m.d, hit: r.hit });
        g.last = { seat, type: 'move', from, to, hit: r.hit, at: now() };
        if (g.off[seat] === 15) { this.finishGame(t, seat); return { ok: true }; }
        if (!g.left.length || !analyze(g, seat, g.left).max) g.phase = 'confirm';
        return { ok: true };
      }
      if (type === 'undo') {
        if (!g.stack.length || (g.phase !== 'move' && g.phase !== 'confirm')) return { error: 'Geri alınacak hamle yok' };
        const st = g.stack.pop(); Object.assign(g, { board: st.board, bar: st.bar, off: st.off, left: st.left, moves: st.moves }); g.phase = 'move';
        g.last = { seat, type: 'undo', at: now() };
        return { ok: true };
      }
      if (type === 'confirm') {
        if (g.phase !== 'confirm') return { error: 'Önce hamlelerinizi oynayın' };
        const hits = g.moves.filter(m => m.hit).length;
        this.log(t, seat, `${this.nm(t, seat)} oynadı${hits ? ` · ${hits} pul kırdı` : ''}`);
        this.pass(t, seat); return { ok: true };
      }
      return { error: 'Geçersiz hamle' };
    },
    pass(t, seat) { const g = t.game; g.turn = 1 - seat; g.phase = 'roll'; g.left = []; g.stack = []; g.lastMoves = g.moves; g.lastMover = seat; g.moves = []; },
    finishGame(t, w) {
      const g = t.game; const l = 1 - w; const mars = g.off[l] === 0; const pts = mars ? 2 : 1;
      g.totals[w] += pts; g.history.push({ winner: w, pts, mars }); g.handScores = { winner: w, pts, mars, pipL: pip(g, l) };
      g.handOver = true; g.winner = w; g.phase = 'done'; g.lastMoves = g.moves; g.lastMover = w;
      this.log(t, w, `${this.nm(t, w)} oyunu aldı${mars ? ' · MARS! 2 puan' : ' · 1 puan'}`);
    },
    nextHand(t) { const g = t.game; this.newGame(t, g, g.winner != null ? g.winner : 1 - g.first); },
    result(t) {
      const g = t.game; const w = g.totals[0] > g.totals[1] ? 0 : 1;
      return { ranking: [t.seats[w].id, t.seats[1 - w].id], totals: g.totals, draw: false, history: g.history };
    },
    view(t, seat) {
      const g = t.game;
      return { game: g.game, target: t.options.target, totals: g.totals, board: g.board, bar: g.bar, off: g.off, turn: g.turn, phase: g.phase,
        dice: g.dice, left: g.left, moves: g.moves, lastMoves: g.lastMoves || [], lastMover: g.lastMover, legal: seat === g.turn ? this.legal(g, seat) : [],
        canUndo: seat === g.turn && g.stack.length > 0 && (g.phase === 'move' || g.phase === 'confirm'),
        pips: [pip(g, 0), pip(g, 1)], handOver: g.handOver, handScores: g.handScores, history: g.history, log: g.log.slice(-8), last: g.last, winner: g.winner };
    },
    bot(t, seat) {
      const g = t.game;
      if (g.phase === 'roll') return { type: 'roll' };
      if (g.phase === 'confirm') return { type: 'confirm' };
      if (g.phase !== 'move') return null;
      const seqs = finals(g, seat, g.left);
      let best = null, bs = -Infinity;
      for (const q of seqs) { let sc = evaluate(q.st, seat) + q.path.filter(m => m.hit).length * 6 + (q.st.off[seat] === 15 ? 1000 : 0); if (sc > bs) { bs = sc; best = q; } }
      if (!best || !best.path.length) return { type: 'confirm' };
      return { type: 'move', from: best.path[0].from, to: best.path[0].to };
    },
  };
  E.fallback = (t, seat) => { const g = t.game; if (g.phase === 'roll') return { type: 'roll' }; if (g.phase === 'confirm') return { type: 'confirm' }; const L = E.legal(g, seat); return L.length ? { type: 'move', from: L[0].from, to: L[0].to } : null; };
  E._analyze = analyze; E._finals = finals; E._start = start; E._singles = singles; E._pip = pip;
  return E;
};
