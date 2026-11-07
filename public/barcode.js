// Afhankelijkheidsloze EAN-13 / EAN-8 / UPC-A decoder voor foto's (ImageData-achtig).
// Geen DOM-API's in decodeBarcode, dus ook bruikbaar in Node.

// Looplengtes (spatie, balk, spatie, balk) in modules voor cijfer 0-9 (L-code).
// R-code heeft dezelfde breedtes (andere kleur); G-code is de omgekeerde volgorde.
const L = [[3,2,1,1],[2,2,2,1],[2,1,2,2],[1,4,1,1],[1,1,3,2],[1,2,3,1],[1,1,1,4],[1,3,1,2],[1,2,1,3],[3,1,1,2]];
const G = L.map((p) => [...p].reverse());
// Pariteit van de zes linkercijfers bepaalt het eerste cijfer van EAN-13.
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
const MAX_DIGIT_DIST = 1.4; // maximale afstand van een cijfer tot zijn beste patroon (in modules)

// Controlecijfer: gewichten 3/1 van rechts (zonder het controlecijfer zelf).
function checkOk(d) {
  let s = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) s += d[i] * w;
  return (10 - (s % 10)) % 10 === d[d.length - 1];
}

// Beste patroon voor 4 looplengtes; normaliseert op het totaal (=7 modules).
function matchDigit(w, o, mod, useG) {
  const tot = w[o] + w[o + 1] + w[o + 2] + w[o + 3];
  if (Math.abs(tot / 7 - mod) > 0.4 * mod) return null;
  const n = [0, 1, 2, 3].map((i) => (w[o + i] * 7) / tot);
  let best = null;
  for (const [set, name] of useG ? [[L, 'L'], [G, 'G']] : [[L, 'L']]) {
    for (let d = 0; d < 10; d++) {
      let dist = 0;
      for (let i = 0; i < 4; i++) dist += Math.abs(n[i] - set[d][i]);
      if (!best || dist < best.dist) best = { dist, digit: d, par: name };
    }
  }
  return best.dist <= MAX_DIGIT_DIST ? best : null;
}

// Controleert of n opeenvolgende looplengtes ongeveer één modulebreedte zijn.
function guardOk(w, o, n, mod) {
  for (let i = 0; i < n; i++) if (Math.abs(w[o + i] - mod) > 0.65 * mod) return false;
  return true;
}

// Probeert een barcode te lezen die begint bij donkere run j. digits = 6 (EAN-13) of 4 (EAN-8).
function decodeAt(w, j, half) {
  const need = 3 + half * 4 + 5 + half * 4 + 3;
  if (j + need > w.length) return null;
  const mod = (w[j] + w[j + 1] + w[j + 2]) / 3;
  if (j > 0 && w[j - 1] < 2.5 * mod) return null; // stille zone ontbreekt
  const cEnd = j + 3 + half * 4;
  if (!guardOk(w, j, 3, mod) || !guardOk(w, cEnd, 5, mod) || !guardOk(w, cEnd + 5 + half * 4, 3, mod)) return null;
  const d = [], par = [];
  let err = 0;
  for (let i = 0; i < half; i++) {
    const m = matchDigit(w, j + 3 + i * 4, mod, half === 6);
    if (!m) return null;
    d.push(m.digit); par.push(m.par); err += m.dist;
  }
  for (let i = 0; i < half; i++) {
    const m = matchDigit(w, cEnd + 5 + i * 4, mod, false);
    if (!m) return null;
    d.push(m.digit); err += m.dist;
  }
  if (half === 6) {
    const first = PARITY.indexOf(par.join(''));
    if (first < 0) return null;
    d.unshift(first);
  }
  if (!checkOk(d)) return null;
  return { text: d.join(''), err: err / (half * 2) };
}

// Zet een rij grijswaarden om in randposities (subpixel) met lokale drempel.
function lineRuns(g) {
  const n = g.length;
  let lo = 255, hi = 0;
  for (let i = 0; i < n; i++) { if (g[i] < lo) lo = g[i]; if (g[i] > hi) hi = g[i]; }
  if (hi - lo < 30) return null;
  const gmid = (lo + hi) / 2;
  const b = Math.max(4, n >> 5), nb = Math.ceil(n / b);
  const bmin = new Float32Array(nb).fill(255), bmax = new Float32Array(nb);
  for (let i = 0; i < n; i++) {
    const k = (i / b) | 0;
    if (g[i] < bmin[k]) bmin[k] = g[i];
    if (g[i] > bmax[k]) bmax[k] = g[i];
  }
  // Drempel per blok: midden van min/max in een venster van ~9 blokken, anders het globale midden.
  const thr = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    let mn = 255, mx = 0;
    for (let q = Math.max(0, k - 4); q <= Math.min(nb - 1, k + 4); q++) { mn = Math.min(mn, bmin[q]); mx = Math.max(mx, bmax[q]); }
    thr[k] = mx - mn < 0.4 * (hi - lo) ? gmid : (mn + mx) / 2;
  }
  const edges = [];
  let prev = g[0] - thr[0];
  for (let i = 1; i < n; i++) {
    const cur = g[i] - thr[(i / b) | 0];
    if ((prev < 0) !== (cur < 0)) edges.push(i - 1 + prev / (prev - cur));
    prev = cur;
  }
  const w = [];
  for (let i = 1; i < edges.length; i++) w.push(edges[i] - edges[i - 1]);
  // Segment 0 is donker als het eerste sample licht was.
  const firstDark = g[0] - thr[0] >= 0;
  return { w, firstDark };
}

// Leest één scanlijn (voorwaarts); geeft {text, err} of null.
function scanLine(g) {
  const r = lineRuns(g);
  if (!r) return null;
  let best = null;
  for (let j = 0; j + 43 <= r.w.length; j++) {
    if (((j & 1) === 0) !== r.firstDark) continue; // start moet een balk zijn
    const hit = decodeAt(r.w, j, 6) || decodeAt(r.w, j, 4);
    if (hit && (!best || hit.err < best.err)) best = hit;
  }
  return best;
}

// Grijswaarden (Rec.601) uit RGBA.
function toGray({ data, width, height }) {
  const g = new Float32Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return g;
}

// Neemt een lijn (rij of kolom) en middelt met de twee buurlijnen tegen ruis.
function sampleLine(g, W, H, horizontal, pos) {
  const len = horizontal ? W : H, lim = horizontal ? H : W;
  const out = new Float32Array(len);
  const a = Math.max(0, pos - 1), c = Math.min(lim - 1, pos + 1);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let q = a; q <= c; q++) s += horizontal ? g[q * W + i] : g[i * W + q];
    out[i] = s / (c - a + 1);
  }
  return out;
}

export function decodeBarcode(image) {
  const { width: W, height: H } = image;
  if (!W || !H) return null;
  const g = toGray(image);
  const votes = new Map();
  // Eerst weinig lijnen, daarna een dichter raster als er niets gevonden is.
  for (const count of [16, 48]) {
    for (const horizontal of [true, false]) {
      const size = horizontal ? H : W;
      for (let i = 0; i < count; i++) {
        const pos = Math.min(size - 1, Math.floor(((i + 0.5) / count) * size));
        const line = sampleLine(g, W, H, horizontal, pos);
        // Voorwaarts en achterstevoren (180 graden gedraaid).
        for (const l of [line, Float32Array.from(line).reverse()]) {
          const hit = scanLine(l);
          if (!hit) continue;
          const v = votes.get(hit.text) || { n: 0, err: 0 };
          v.n++; v.err += hit.err;
          votes.set(hit.text, v);
        }
      }
    }
    // Winnaar = meeste stemmen; een enkele stem alleen bij zeer nette pasvorm.
    let best = null;
    for (const [text, v] of votes) if (!best || v.n > best.v.n || (v.n === best.v.n && v.err < best.v.err)) best = { text, v };
    if (best && (best.v.n >= 2 || best.v.err / best.v.n < 0.5)) {
      const t = best.text;
      if (t.length === 13 && t[0] === '0') return { format: 'upc_a', text: t.slice(1) };
      return { format: t.length === 13 ? 'ean_13' : 'ean_8', text: t };
    }
  }
  return null;
}

// Hulp voor de browser: tekent een canvas (max ~1280 px breed) uit en decodeert.
export function decodeFromCanvas(canvas) {
  let c = canvas;
  if (canvas.width > 1280) {
    c = canvas.ownerDocument.createElement('canvas');
    c.width = 1280;
    c.height = Math.round((canvas.height * 1280) / canvas.width);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  }
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  return decodeBarcode({ data, width, height });
}
