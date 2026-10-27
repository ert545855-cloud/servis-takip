'use strict';
/* 101 Okey motoru (4 kişi). Kurallar: pagat.com/rummy/okey101.html ve yaygın Türk kuralları. */
const K = require('./public/okey-core.js');
module.exports = function okeyEngine({ shuffle, now }) {
  const { isJ, eff, evalGroup, addTo, canAddAny, bestMelds, findPairs, usefulness, okeyOf, tileName } = K;
  const T = g => g.tiles; // id === dizin
  const nm = (t, s) => (t.seats[s] ? t.seats[s].name : 'Oyuncu');
  const log = (t, s, text) => { const g = t.game; g.log.push({ seat: s, text, at: now() }); if (g.log.length > 30) g.log.splice(0, g.log.length - 30); };
  const handTiles = (g, s) => g.hands[s].map(id => g.tiles[id]);
  const tn = (g, id) => tileName(g.tiles[id], g.ok);

  const E = {
    name: '101 Okey', seats: [4], timeLimit: 60, betweenMs: 9000, optionsSpec: { hands: [1, 3, 5, 7] },
    options: o => ({ seats: 4, hands: [1, 3, 5, 7].includes(Number(o.hands)) ? Number(o.hands) : 3 }),
    botDelay: () => 1200 + Math.random() * 1000,
    init(t) { const g = { hand: 0, handCount: t.options.hands || 3, totals: [0, 0, 0, 0], dealer: Math.floor(Math.random() * 4), history: [] }; this.deal(t, g); return g; },
    deal(t, g) {
      g.hand++;
      const tiles = []; for (let c = 0; c < 4; c++) for (let n = 1; n <= 13; n++) for (let k = 0; k < 2; k++) tiles.push({ id: tiles.length, c, n });
      tiles.push({ id: tiles.length, f: 1 }, { id: tiles.length + 1, f: 1 });
      g.tiles = tiles; const deck = shuffle(tiles.map(x => x.id));
      const ii = deck.findIndex(id => !tiles[id].f); g.indicator = deck.splice(ii, 1)[0]; g.ok = okeyOf(tiles[g.indicator]);
      const s0 = (g.dealer + 1) % 4;
      g.hands = [[], [], [], []]; for (let i = 0; i < 4; i++) { const s = (s0 + i) % 4; g.hands[s] = deck.splice(0, s === s0 ? 22 : 21); }
      g.deck = deck; g.discards = [[], [], [], []]; g.melds = []; g.mid = 1; g.opened = [null, null, null, null]; g.pen = [0, 0, 0, 0];
      g.turn = s0; g.phase = 'play'; g.took = null; g.turnActs = 0; g.turnNo = 1; g.noSide = null; g.log = []; g.last = null;
      g.handOver = false; g.handScores = null; g.reveal = null; g.winner = null;
      g.log.push({ seat: s0, at: now(), text: `${g.hand}. el başladı. Gösterge ${tn(g, g.indicator)}, okey ${K.COLORS[g.ok.c].toLowerCase()} ${g.ok.n}. ${nm(t, s0)} 22 taşla başlıyor, ilk taşı atacak.` });
    },
    turnSeat(t) { const g = t.game; return g && !g.handOver ? g.turn : null; },
    between(t) { return !!(t.game && t.game.handOver && !this.isOver(t)); },
    isOver(t) { const g = t.game; return !!(g && g.handOver && g.hand >= g.handCount); },
    act(t, seat, a) {
      const g = t.game; if (g.handOver) return { error: 'El bitti' };
      if (g.turn !== seat) return { error: 'Sıra sizde değil' };
      const hand = g.hands[seat]; const prev = (seat + 3) % 4; const tl = g.tiles;
      const type = a && a.type;
      if (type === 'draw') {
        if (g.phase !== 'draw') return { error: 'Bu el taş çektiniz, şimdi taş atın' };
        if (a.from === 'side') {
          const pile = g.discards[prev]; if (!pile.length) return { error: 'Yanda alınacak taş yok' };
          const id = pile.pop(); hand.push(id); g.took = id; g.phase = 'play';
          g.last = { seat, type: 'take', tile: tl[id], at: now() }; log(t, seat, `${nm(t, seat)} yandan ${tn(g, id)} aldı`);
          return { ok: true };
        }
        if (!g.deck.length) return { error: 'Deste bitti' };
        hand.push(g.deck.shift()); g.phase = 'play'; g.last = { seat, type: 'draw', at: now() };
        return { ok: true };
      }
      if (g.phase !== 'play') return { error: 'Önce ortadan veya yandan taş çekin' };
      if (type === 'untake') {
        if (g.took == null || !hand.includes(g.took)) return { error: 'Geri konacak taş yok' };
        hand.splice(hand.indexOf(g.took), 1); g.discards[prev].push(g.took); log(t, seat, `${nm(t, seat)} yandan aldığı taşı geri koydu`);
        g.took = null; g.phase = 'draw'; g.noSide = seat; g.last = { seat, type: 'untake', at: now() };
        return { ok: true };
      }
      if (type === 'meld') {
        const groups = Array.isArray(a.groups) ? a.groups.slice(0, 12) : [];
        if (!groups.length) return { error: 'Per seçin' };
        const all = groups.flat(); if (new Set(all).size !== all.length || all.some(id => !hand.includes(id))) return { error: 'Seçilen taşlar elinizde değil' };
        if (hand.length - all.length < 1) return { error: 'Son taşı atabilmek için elinizde en az bir taş kalmalı' };
        const op = g.opened[seat];
        const pairMode = op ? op.type === 'pairs' : groups[0].length === 2;
        const evs = [];
        for (const gr of groups) {
          const ev = evalGroup(gr.map(id => tl[id]), g.ok, pairMode ? 'pair' : 'meld');
          if (!ev) return { error: pairMode ? `${gr.map(id => tn(g, id)).join(', ')} çift değil` : `${gr.map(id => tn(g, id)).join(', ')} geçerli bir per değil` };
          evs.push(ev);
        }
        if (op && op.type === 'pairs' && !pairMode) return { error: 'Çiftle açtınız; yalnızca çift açabilir veya işleyebilirsiniz' };
        if (!op) {
          if (pairMode && evs.length < 5) return { error: `Çiftle açmak için en az 5 çift gerekir (şu an ${evs.length})` };
          const val = evs.reduce((x, e) => x + e.value, 0);
          if (!pairMode && val < 101) return { error: `Açmak için en az 101 gerekir (şu an ${val})` };
          if (g.took != null && hand.includes(g.took) && !all.includes(g.took)) return { error: 'Yandan aldığınız taş açtığınız perlerde olmalı' };
          g.opened[seat] = { type: pairMode ? 'pairs' : 'series', value: pairMode ? evs.length : val, turn: g.turnNo };
          log(t, seat, pairMode ? `${nm(t, seat)} ${evs.length} çiftle açtı` : `${nm(t, seat)} ${val} ile açtı`);
        } else log(t, seat, `${nm(t, seat)} yere ${evs.length} ${pairMode ? 'çift' : 'per'} açtı`);
        for (const ev of evs) { g.melds.push({ ...ev, id: g.mid++, owner: seat }); for (const id of ev.order) hand.splice(hand.indexOf(id), 1); }
        if (all.includes(g.took)) g.took = null;
        g.turnActs++; g.last = { seat, type: 'meld', at: now() };
        return { ok: true };
      }
      if (type === 'add') {
        if (!g.opened[seat]) return { error: 'İşlemek için önce elinizi açmalısınız' };
        const id = Number(a.tile); if (!hand.includes(id)) return { error: 'Bu taş elinizde değil' };
        const mi = g.melds.findIndex(m => m.id === Number(a.meld)); if (mi < 0) return { error: 'Per bulunamadı' };
        if (hand.length < 2) return { error: 'Son taşı atabilmek için elinizde en az bir taş kalmalı' };
        const r = addTo(g.melds[mi], tl[id], g.ok, a.side); if (!r) return { error: `${tn(g, id)} bu pere işlenmez` };
        g.melds[mi] = r; hand.splice(hand.indexOf(id), 1); if (g.took === id) g.took = null;
        g.turnActs++; g.last = { seat, type: 'add', tile: tl[id], meld: r.id, at: now() };
        log(t, seat, `${nm(t, seat)} ${tn(g, id)} işledi`);
        return { ok: true };
      }
      if (type === 'discard') {
        const id = Number(a.tile); if (!hand.includes(id)) return { error: 'Bu taş elinizde değil' };
        if (g.took != null && hand.includes(g.took)) return { error: 'Yandan aldığınız taşı bu el açarak ya da işleyerek kullanmalısınız. Kullanamıyorsanız "Geri koy" deyin.' };
        hand.splice(hand.indexOf(id), 1); g.discards[seat].push(id);
        const finishing = hand.length === 0; const jk = isJ(tl[id], g.ok);
        g.last = { seat, type: 'discard', tile: tl[id], at: now() };
        if (!finishing) {
          if (jk) { g.pen[seat] += 101; log(t, seat, `${nm(t, seat)} okey attı: 101 ceza`); }
          else if (canAddAny(g.melds, tl[id], g.ok)) { g.pen[seat] += 101; log(t, seat, `${nm(t, seat)} işlek taş attı (${tn(g, id)}): 101 ceza`); }
          else log(t, seat, `${nm(t, seat)} ${tn(g, id)} attı`);
        }
        if (finishing) { this.endHand(t, seat, jk); return { ok: true }; }
        if (!g.deck.length) { log(t, seat, 'Deste bitti, el kazanansız kapandı'); this.endHand(t, null, false); return { ok: true }; }
        g.turn = (seat + 1) % 4; g.phase = 'draw'; g.took = null; g.turnActs = 0; g.turnNo++; g.noSide = null;
        return { ok: true };
      }
      return { error: 'Geçersiz hamle' };
    },
    endHand(t, w, jf) {
      const g = t.game; const tl = g.tiles;
      const val = s => g.hands[s].reduce((x, id) => x + (isJ(tl[id], g.ok) ? 101 : eff(tl[id], g.ok).n), 0);
      const scores = [0, 1, 2, 3].map(i => {
        const op = g.opened[i]; let base = 0; let note = '';
        if (w != null) {
          const wp = g.opened[w].type === 'pairs'; const mult = (wp ? 2 : 1) * (jf ? 2 : 1);
          const elden = g.opened[w].turn === g.turnNo && g.opened.every((o, k) => k === w || !o);
          if (i === w) { base = elden ? -202 * (jf ? 2 : 1) : -101 * mult; note = elden ? 'Elden bitti' : jf ? 'Okeyle bitti' : 'Bitti'; }
          else if (elden) { base = 404 * (jf ? 2 : 1); note = 'Rakip elden bitti'; }
          else if (!op) { base = 202 * mult; note = 'Açamadı'; }
          else { base = val(i) * mult * (op.type === 'pairs' ? 2 : 1); note = `Elde ${g.hands[i].length} taş`; }
        } else { const j = g.hands[i].filter(id => isJ(tl[id], g.ok)).length; base = j * 101; note = j ? `${j} okey elde kaldı` : 'Kazanan yok'; }
        return { base, pen: g.pen[i], score: base + g.pen[i], note, opened: op ? op.type : null, left: g.hands[i].length, winner: i === w };
      });
      scores.forEach((s, i) => { g.totals[i] += s.score; });
      g.history.push(scores.map(s => s.score)); g.handScores = scores; g.handOver = true; g.turn = null; g.winner = w; g.jf = !!jf;
      g.reveal = g.hands.map(h => h.slice());
      if (w != null) log(t, w, `${nm(t, w)} eli bitirdi${jf ? ' (okey atarak, puanlar katlandı)' : ''}`);
    },
    nextHand(t) { const g = t.game; g.dealer = (g.dealer + 1) % 4; this.deal(t, g); },
    result(t) {
      const g = t.game; const order = g.totals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      return { ranking: order.map(([, i]) => t.seats[i].id), totals: g.totals, draw: order[0][0] === order[1][0], history: g.history, low: true };
    },
    view(t, seat) {
      const g = t.game; const tl = g.tiles; const T2 = id => tl[id];
      const mine = seat >= 0 ? g.hands[seat] : [];
      return {
        hand: g.hand, hands: g.handCount, ok: g.ok, indicator: tl[g.indicator], deck: g.deck.length, turn: g.turn, phase: g.phase, took: g.took, turnNo: g.turnNo, dealer: g.dealer,
        my: mine.map(T2), counts: g.hands.map(h => h.length),
        discards: g.discards.map(p => p.slice(-5).map(T2)), dcount: g.discards.map(p => p.length),
        melds: g.melds.map(m => ({ id: m.id, owner: m.owner, type: m.type, tiles: m.order.map(T2), value: m.value, n: m.n, c: m.c, start: m.start, end: m.end })),
        opened: g.opened.map(o => o && { type: o.type, value: o.value }), pen: g.pen, totals: g.totals, history: g.history,
        handOver: g.handOver, handScores: g.handScores, winner: g.winner, jf: !!g.jf, reveal: g.handOver && g.reveal ? g.reveal.map(h => h.map(T2)) : null,
        log: g.log.slice(-10), last: g.last,
        extendable: seat >= 0 ? mine.filter(id => !isJ(tl[id], g.ok) && canAddAny(g.melds, tl[id], g.ok)) : [],
      };
    },
    /* ---------- bot ---------- */
    bot(t, seat, ctx) {
      const g = t.game; const human = ctx && ctx.human; const tl = g.tiles; const prev = (seat + 3) % 4;
      const hand = g.hands[seat]; const H = () => handTiles(g, seat); const op = g.opened[seat];
      if (g.phase === 'draw') {
        const side = g.discards[prev][g.discards[prev].length - 1];
        if (!human && side != null && g.noSide !== seat) {
          const st = tl[side];
          if (op && op.type === 'series' && !isJ(st, g.ok) && canAddAny(g.melds, st, g.ok)) return { type: 'draw', from: 'side' };
          if (op && op.type === 'series') { const r = bestMelds([...H(), st], g.ok, { limit: 8000 }); if (r.groups.some(gr => gr.includes(side))) return { type: 'draw', from: 'side' }; }
          if (!op) { const r = bestMelds([...H(), st], g.ok, { limit: 15000 }); if (r.value >= 101 && r.groups.some(gr => gr.includes(side)) && r.groups.flat().length < hand.length + 1) return { type: 'draw', from: 'side' }; }
        }
        if (!g.deck.length) return null;
        return { type: 'draw', from: 'deck' };
      }
      // yandan alınan taş kullanılmalı
      if (g.took != null && hand.includes(g.took)) {
        if (!human && (!op || op.type === 'series')) {
          if (op) { const m = g.melds.find(mm => addTo(mm, tl[g.took], g.ok)); if (m) return { type: 'add', tile: g.took, meld: m.id }; }
          const r = bestMelds(H(), g.ok, { limit: 15000 });
          if (r.groups.some(gr => gr.includes(g.took)) && (op || r.value >= 101) && r.groups.flat().length < hand.length) return { type: 'meld', groups: r.groups };
        }
        return { type: 'untake' };
      }
      if (!human) {
        if (!op) {
          const r = bestMelds(H(), g.ok, { limit: 30000 });
          let groups = r.groups, val = r.value;
          if (groups.flat().length >= hand.length) { groups = groups.slice().sort((a, b) => a.length - b.length); const drop = groups.shift(); val -= evalGroup(drop.map(id => tl[id]), g.ok, 'meld').value; }
          if (val >= 101 && groups.length) return { type: 'meld', groups };
          const pairs = findPairs(H(), g.ok);
          if (pairs.length >= 5 && r.value < 80) { const ps = pairs.length * 2 >= hand.length ? pairs.slice(0, pairs.length - 1) : pairs; if (ps.length >= 5) return { type: 'meld', groups: ps }; }
        } else {
          if (op.type === 'series') {
            const r = bestMelds(H(), g.ok, { limit: 15000 }); let groups = r.groups;
            if (groups.flat().length >= hand.length) groups = groups.slice().sort((a, b) => b.length - a.length).slice(0, -1);
            if (groups.length) return { type: 'meld', groups };
          } else {
            const pairs = findPairs(H(), g.ok); const ps = pairs.length * 2 >= hand.length ? pairs.slice(0, -1) : pairs;
            if (ps.length) return { type: 'meld', groups: ps };
          }
          if (hand.length > 1) for (const id of hand) { const m = g.melds.find(mm => addTo(mm, tl[id], g.ok)); if (m) return { type: 'add', tile: id, meld: m.id }; }
        }
      }
      return { type: 'discard', tile: this.pickDiscard(g, seat) };
    },
    pickDiscard(g, seat) {
      const tl = g.tiles; const hand = g.hands[seat]; const H = handTiles(g, seat);
      if (hand.length === 1) return hand[0];
      const cand = H.filter(t => !isJ(t, g.ok)); const pool = cand.length ? cand : H;
      const opPairs = g.opened[seat] && g.opened[seat].type === 'pairs';
      const score = t => {
        let s = usefulness(t, H, g.ok);
        if (opPairs) s = H.filter(o => o.id !== t.id && !isJ(o, g.ok) && eff(o, g.ok).c === eff(t, g.ok).c && eff(o, g.ok).n === eff(t, g.ok).n).length * 5;
        if (canAddAny(g.melds, t, g.ok)) s += 50; // işlek taş atma cezası
        s -= (isJ(t, g.ok) ? 0 : eff(t, g.ok).n) * (g.opened[seat] ? 0.08 : -0.02);
        return s;
      };
      return pool.slice().sort((a, b) => score(a) - score(b))[0].id;
    },
  };
  E.fallback = (t, seat) => E.bot(t, seat, { human: true });
  return E;
};
