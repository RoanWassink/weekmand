import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBarcode } from '../public/barcode.js';

const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const R = L.map((p) => [...p].map((c) => (c === '0' ? '1' : '0')).join(''));
const G = R.map((p) => [...p].reverse().join(''));
const PAR = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

function checkDigit(body: string): number {
  let s = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = 4 - w) s += Number(body[i]) * w;
  return (10 - (s % 10)) % 10;
}
const ean13 = (b: string) => b + checkDigit(b);

// Bouwt de modulestring ('1' = balk) voor EAN-13 of EAN-8.
function modules(code: string): string {
  const d = [...code].map(Number);
  if (code.length === 13) {
    const par = PAR[d[0]];
    let m = '101';
    for (let i = 0; i < 6; i++) m += (par[i] === 'L' ? L : G)[d[i + 1]];
    m += '01010';
    for (let i = 7; i < 13; i++) m += R[d[i]];
    return m + '101';
  }
  let m = '101';
  for (let i = 0; i < 4; i++) m += L[d[i]];
  m += '01010';
  for (let i = 4; i < 8; i++) m += R[d[i]];
  return m + '101';
}

// Deterministische PRNG (mulberry32).
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Gray = { w: number; h: number; v: Float32Array };
interface Opts { mod?: number; heightFrac?: number; W?: number; H?: number; rot?: 0 | 90 | 180; blur?: boolean; noise?: number; lo?: number; hi?: number }

// Rendert een barcode (met stille zone en anti-aliasing door subsampling) naar grijswaarden.
function render(code: string, o: Opts = {}): Gray {
  const mod = o.mod ?? 3, m = modules(code);
  const quiet = 11 * mod, bw = m.length * mod;
  const W = o.W ?? Math.ceil(bw + 2 * quiet + 40), H = o.H ?? 200;
  const bh = Math.round(H * (o.heightFrac ?? 0.6)), y0 = Math.floor((H - bh) / 2);
  const x0 = (W - bw) / 2;
  let v = new Float32Array(W * H).fill(255);
  for (let x = 0; x < W; x++) {
    let dark = 0;
    for (let s = 0; s < 8; s++) {
      const mi = Math.floor((x + (s + 0.5) / 8 - x0) / mod);
      if (mi >= 0 && mi < m.length && m[mi] === '1') dark++;
    }
    const val = 255 * (1 - dark / 8);
    for (let y = y0; y < y0 + bh; y++) v[y * W + x] = val;
  }
  let img: Gray = { w: W, h: H, v };
  if (o.rot === 90) {
    const t = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[x * H + (H - 1 - y)] = v[y * W + x];
    img = { w: H, h: W, v: t };
  } else if (o.rot === 180) img = { w: W, h: H, v: Float32Array.from(v).reverse() };
  if (o.blur) img = boxBlur(img, 3);
  if (o.lo !== undefined && o.hi !== undefined) for (let i = 0; i < img.v.length; i++) img.v[i] = o.lo + (img.v[i] / 255) * (o.hi - o.lo);
  if (o.noise) {
    const r = prng(42);
    for (let i = 0; i < img.v.length; i++) img.v[i] += (r() * 2 - 1) * o.noise;
  }
  return img;
}

function boxBlur(g: Gray, k: number): Gray {
  const out = new Float32Array(g.v.length), h = k >> 1;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    let s = 0, n = 0;
    for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < g.h && xx >= 0 && xx < g.w) { s += g.v[yy * g.w + xx]; n++; }
    }
    out[y * g.w + x] = s / n;
  }
  return { w: g.w, h: g.h, v: out };
}

function toImage(g: Gray) {
  const data = new Uint8ClampedArray(g.w * g.h * 4);
  for (let i = 0; i < g.v.length; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g.v[i]; data[i * 4 + 3] = 255; }
  return { data, width: g.w, height: g.h };
}
const dec = (code: string, o?: Opts) => decodeBarcode(toImage(render(code, o)));

const E13 = ean13('871040000000'), E13b = ean13('400638133393'), E13c = ean13('590123412345');
const E8 = '96385074', UPCA = '036000291452';

test('EAN-13 bekende codes', () => {
  for (const c of [E13, E13b, E13c, '4006381333931']) {
    assert.equal(c.length, 13);
    assert.deepEqual(dec(c), { format: 'ean_13', text: c });
  }
});

test('EAN-8', () => assert.deepEqual(dec(E8), { format: 'ean_8', text: E8 }));

test('UPC-A (als EAN-13 met voorloop 0)', () => {
  assert.equal(checkDigit(UPCA.slice(0, 11)), 2);
  assert.deepEqual(dec('0' + UPCA), { format: 'upc_a', text: UPCA });
});

test('verschillende schalen, ook niet-gehele', () => {
  for (const mod of [1.5, 1.7, 2, 2.35, 3, 3.3, 4]) assert.deepEqual(dec(E13, { mod }), { format: 'ean_13', text: E13 }, `mod ${mod}`);
});

test('lage barcode (30% van beeld), gedraaid', () => {
  const o = { heightFrac: 0.3, H: 300 };
  assert.deepEqual(dec(E13, o), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E13, { ...o, rot: 90 }), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E13, { ...o, rot: 180 }), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E8, { rot: 90, mod: 2.5 }), { format: 'ean_8', text: E8 });
});

test('ruis, vervaging en laag contrast', () => {
  assert.deepEqual(dec(E13, { noise: 40 }), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E13, { noise: 40, mod: 2 }), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E13, { blur: true, mod: 3 }), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E13, { lo: 60, hi: 200 }), { format: 'ean_13', text: E13 });
  assert.deepEqual(dec(E13, { lo: 60, hi: 200, noise: 30, mod: 2.5 }), { format: 'ean_13', text: E13 });
});

test('geen barcode of ongeldig controlecijfer geeft null', () => {
  const r = prng(7);
  const v = new Float32Array(400 * 300);
  for (let i = 0; i < v.length; i++) v[i] = 200 + (r() - 0.5) * 60;
  for (let y = 50; y < 250; y += 40) for (let x = 40; x < 360; x++) v[y * 400 + x] = 30; // strepen/tekstregels
  assert.equal(decodeBarcode(toImage({ w: 400, h: 300, v })), null);
  assert.equal(dec('8710400000001'.slice(0, 12) + ((checkDigit('871040000000') + 1) % 10)), null);
  assert.equal(dec('5901234123450'), null);
});
