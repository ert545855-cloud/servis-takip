/* 101 Okey çekirdeği: per kontrolü, işleme ve per bulma. Sunucu (Node) ve tarayıcı aynı dosyayı kullanır. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OkeyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const COLORS = ['Kırmızı', 'Sarı', 'Mavi', 'Siyah'];
  const okeyOf = ind => ({ c: ind.c, n: ind.n === 13 ? 1 : ind.n + 1 });
  // f: sahte okey (okey taşının yerine geçer, joker değildir)
  const isJ = (t, ok) => !!t && !t.f && t.c === ok.c && t.n === ok.n;
  const eff = (t, ok) => (t.f ? { c: ok.c, n: ok.n } : { c: t.c, n: t.n });
  const tileName = (t, ok) => { if (!t) return ''; if (isJ(t, ok)) return 'okey'; const e = eff(t, ok); return COLORS[e.c].toLowerCase() + ' ' + e.n + (t.f ? ' (sahte okey)' : ''); };
  const sumRange = (a, b) => ((b - a + 1) * (a + b)) / 2;

  function evalSet(tiles, N, J) {
    const len = tiles.length; if (len < 3 || len > 4 || !N.length) return null;
    const n = N[0].n; if (N.some(x => x.n !== n)) return null;
    const cols = N.map(x => x.c); if (new Set(cols).size !== cols.length) return null;
    return { type: 'set', n, colors: cols, len, value: n * len, order: tiles.map(t => t.id) };
  }
  function evalRun(tiles, N, J, ok) {
    const len = tiles.length; if (len < 3 || len > 13 || !N.length) return null;
    const c = N[0].c; if (N.some(x => x.c !== c)) return null;
    if (new Set(N.map(x => x.n)).size !== N.length) return null;
    // önce verilen sırayı dene (artan veya azalan)
    for (const arr of [tiles, [...tiles].reverse()]) {
      const i = arr.findIndex(t => !isJ(t, ok)); const start = eff(arr[i], ok).n - i; const end = start + len - 1;
      if (start < 1 || end > 13) continue;
      if (arr.every((t, k) => isJ(t, ok) || eff(t, ok).n === start + k)) return { type: 'run', c, start, end, len, value: sumRange(start, end), order: arr.map(t => t.id) };
    }
    // kendimiz yerleştirelim
    const ns = N.map(x => x.n).sort((a, b) => a - b);
    let start = ns[0], end = ns[ns.length - 1]; const gaps = end - start + 1 - ns.length; let extra = J.length - gaps;
    if (extra < 0) return null;
    while (extra > 0 && end < 13) { end++; extra--; }
    while (extra > 0 && start > 1) { start--; extra--; }
    if (extra > 0) return null;
    const byN = new Map(N.map(x => [x.n, x.id])); const js = J.map(t => t.id); const order = [];
    for (let n = start; n <= end; n++) order.push(byN.has(n) ? byN.get(n) : js.shift());
    return { type: 'run', c, start, end, len, value: sumRange(start, end), order };
  }
  // want: 'pair' | 'meld' | undefined
  function evalGroup(tiles, ok, want) {
    if (!tiles || tiles.length < 2) return null;
    const J = tiles.filter(t => isJ(t, ok)); const N = tiles.filter(t => !isJ(t, ok)).map(t => ({ ...eff(t, ok), id: t.id }));
    if (tiles.length === 2) {
      if (want === 'meld') return null;
      if (J.length || (N[0].c === N[1].c && N[0].n === N[1].n)) return { type: 'pair', len: 2, value: J.length === 2 ? 0 : 2 * (N[0] ? N[0].n : 0), order: tiles.map(t => t.id) };
      return null;
    }
    if (want === 'pair') return null;
    const s = evalSet(tiles, N, J), r = evalRun(tiles, N, J, ok);
    if (s && r) return r.value >= s.value ? r : s;
    return s || r;
  }
  // yerdeki pere taş eklenebilir mi? Eklenirse yeni per bilgisini döndürür.
  function addTo(meld, t, ok, side) {
    if (!meld || meld.type === 'pair') return null;
    if (meld.type === 'set') {
      if (meld.len >= 4) return null;
      if (isJ(t, ok)) return { ...meld, len: meld.len + 1, value: meld.n * (meld.len + 1), order: [...meld.order, t.id] };
      const e = eff(t, ok); if (e.n !== meld.n || meld.colors.includes(e.c)) return null;
      return { ...meld, len: meld.len + 1, colors: [...meld.colors, e.c], value: meld.n * (meld.len + 1), order: [...meld.order, t.id] };
    }
    const tail = { ...meld, end: meld.end + 1, len: meld.len + 1, value: meld.value + meld.end + 1, order: [...meld.order, t.id] };
    const head = { ...meld, start: meld.start - 1, len: meld.len + 1, value: meld.value + meld.start - 1, order: [t.id, ...meld.order] };
    if (isJ(t, ok)) {
      if (side === 'L' && meld.start > 1) return head;
      if (meld.end < 13) return tail;
      if (meld.start > 1) return head;
      return null;
    }
    const e = eff(t, ok); if (e.c !== meld.c) return null;
    if (e.n === meld.end + 1 && meld.end < 13) return tail;
    if (e.n === meld.start - 1 && meld.start > 1) return head;
    return null;
  }
  const canAddAny = (melds, t, ok) => melds.some(m => addTo(m, t, ok));

  /* ---- per bulucu (bot ve "perleri bul" düğmesi için) ---- */
  function bestMelds(hand, ok, opts) {
    opts = opts || {};
    const jok = hand.filter(t => isJ(t, ok)).map(t => t.id);
    const pools = new Map(); // anahtar c*13+n-1
    for (const t of hand) { if (isJ(t, ok)) continue; const e = eff(t, ok); const k = e.c * 13 + e.n - 1; if (!pools.has(k)) pools.set(k, []); pools.get(k).push(t.id); }
    const cnt = new Array(52).fill(0); for (const [k, a] of pools) cnt[k] = a.length;
    const cands = [];
    for (let c = 0; c < 4; c++) for (let s = 1; s <= 11; s++) for (let e = s + 2; e <= 13; e++) {
      const need = []; let miss = 0; for (let n = s; n <= e; n++) { const k = c * 13 + n - 1; if (cnt[k]) need.push(k); else { miss++; need.push(-1); } }
      if (miss > jok.length) break;
      if (need.every(k => k < 0)) continue;
      cands.push({ kind: 'run', c, s, e, need, j: miss, value: sumRange(s, e) });
    }
    for (let n = 1; n <= 13; n++) {
      const P = [0, 1, 2, 3].filter(c => cnt[c * 13 + n - 1]); if (!P.length) continue;
      const seen = new Set();
      for (const len of [3, 4]) for (let take = Math.min(P.length, len); take >= 1; take--) {
        const miss = len - take; if (miss > jok.length || len - miss < 1) continue;
        // P'den 'take' renk seç
        const combos = []; const rec = (i, acc) => { if (acc.length === take) { combos.push(acc.slice()); return; } for (let x = i; x < P.length; x++) { acc.push(P[x]); rec(x + 1, acc); acc.pop(); } }; rec(0, []);
        for (const cols of combos) { const key = len + ':' + cols.join(''); if (seen.has(key)) continue; seen.add(key);
          cands.push({ kind: 'set', n, need: [...cols.map(c => c * 13 + n - 1), ...Array(miss).fill(-1)], j: miss, value: n * len }); }
      }
    }
    cands.sort((a, b) => b.value - a.value || a.j - b.j);
    let remVal = 0; for (let k = 0; k < 52; k++) remVal += cnt[k] * (k % 13 + 1); remVal += jok.length * 13;
    let best = { value: 0, pick: [] }; let nodes = 0; const LIMIT = opts.limit || 40000; const pick = [];
    const usedVal = c => { let v = 0; for (const k of c.need) if (k >= 0) v += k % 13 + 1; return v + c.j * 13; };
    function dfs(i, jl, val, rem) {
      if (val > best.value) best = { value: val, pick: pick.slice() };
      if (++nodes > LIMIT || val + rem <= best.value) return;
      for (let x = i; x < cands.length; x++) {
        const c = cands[x]; if (c.j > jl) continue;
        let okk = true; for (const k of c.need) if (k >= 0 && --cnt[k] < 0) okk = false;
        if (okk) { pick.push(c); dfs(x, jl - c.j, val + c.value, rem - usedVal(c)); pick.pop(); }
        for (const k of c.need) if (k >= 0) cnt[k]++;
        if (nodes > LIMIT) return;
      }
    }
    dfs(0, jok.length, 0, remVal);
    // gerçek taşları ata
    const P2 = new Map([...pools].map(([k, a]) => [k, a.slice()])); const J2 = jok.slice();
    const groups = best.pick.map(c => c.need.map(k => (k >= 0 ? P2.get(k).shift() : J2.shift())));
    return { value: best.value, groups, kinds: best.pick.map(c => c.kind) };
  }
  function findPairs(hand, ok) {
    const jok = hand.filter(t => isJ(t, ok)).map(t => t.id); const by = new Map(); const singles = [];
    for (const t of hand) { if (isJ(t, ok)) continue; const e = eff(t, ok); const k = e.c * 13 + e.n; if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
    const pairs = [];
    for (const [, a] of by) { while (a.length >= 2) pairs.push([a.shift().id, a.shift().id]); if (a.length) singles.push(a[0]); }
    singles.sort((a, b) => eff(b, ok).n - eff(a, ok).n);
    const J = jok.slice(); while (J.length && singles.length) pairs.push([singles.shift().id, J.shift()]);
    if (J.length === 2) pairs.push([J[0], J[1]]);
    return pairs;
  }
  // taşın elde ne kadar işe yaradığı (atılacak taşı seçmek için)
  function usefulness(t, hand, ok) {
    if (isJ(t, ok)) return 999;
    const e = eff(t, ok); let s = 0;
    for (const o of hand) { if (o.id === t.id) continue; if (isJ(o, ok)) continue; const f = eff(o, ok);
      if (f.n === e.n && f.c !== e.c) s += 2.2;
      if (f.c === e.c) { const d = Math.abs(f.n - e.n); if (d === 1) s += 2.5; else if (d === 2) s += 1.2; else if (d === 0) s += 0.8; } }
    return s;
  }
  return { COLORS, okeyOf, isJ, eff, tileName, evalGroup, addTo, canAddAny, bestMelds, findPairs, usefulness };
});
