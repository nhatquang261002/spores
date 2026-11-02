// JS port of the spores-renderer crate. Integer math only: every value that can
// exceed 2^31 is kept below 2^53 and divided with Math.floor, so results equal
// the Rust i32/u64 arithmetic bit for bit. Mirrors renderer/src/{rng,trig,sim,paint}.rs.
import { createHash } from 'node:crypto';

export const N = 512;
export const C = N / 2;
export const RENDERER_VERSION = 1;
const TURN = 4096, QUARTER = 1024, MASK = TURN - 1;
const RING_R = 168, BOUND_MAX = 215, CAP = 40 * 256, SA = 391, TU = 222, NODE_R = 5;

// ---- rng: xoshiro128** ----
function rngFrom(bytes16) {
  const s = new Uint32Array(4);
  for (let i = 0; i < 4; i++) s[i] = bytes16[4 * i] | (bytes16[4 * i + 1] << 8) | (bytes16[4 * i + 2] << 16) | (bytes16[4 * i + 3] << 24);
  if (!(s[0] | s[1] | s[2] | s[3])) s[0] = 1;
  const next = () => {
    const r = Math.imul((Math.imul(s[1], 5) << 7 | Math.imul(s[1], 5) >>> 25), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return r;
  };
  for (let i = 0; i < 8; i++) next();
  return next;
}

// ---- trig: Q60 Taylor on BigInt ----
const PI_Q60 = 0x3243F6A8885A308Dn;
function sinQ60(k) {
  const x = PI_Q60 * k / 2048n, x2 = (x * x) >> 60n;
  let term = x, sum = x, n = 1n;
  for (;;) {
    term = ((term * x2) >> 60n) / ((2n * n) * (2n * n + 1n));
    if (term === 0n) break;
    if (n % 2n === 1n) sum -= term; else sum += term;
    n++;
  }
  return sum;
}
export function sinTable() {
  const q = [];
  for (let k = 0n; k <= 1024n; k++) q.push(Number((sinQ60(k) + (1n << 43n)) >> 44n));
  const t = new Int32Array(TURN);
  for (let a = 0; a < TURN; a++) {
    const r = a & (QUARTER - 1);
    const v = ((a >> 10) & 1) === 0 ? q[r] : q[QUARTER - r];
    t[a] = a >> 11 === 0 ? v : -v;
  }
  return t;
}
function tables(stepPx, sensePx) {
  const sin = sinTable();
  const cos = (a) => sin[(a + QUARTER) & MASK];
  const T = { sin, cos, stepDx: new Int32Array(TURN), stepDy: new Int32Array(TURN), senseDx: new Int32Array(TURN), senseDy: new Int32Array(TURN) };
  for (let a = 0; a < TURN; a++) {
    T.stepDx[a] = cos(a) * stepPx; T.stepDy[a] = sin[a] * stepPx;
    T.senseDx[a] = (cos(a) * sensePx + 32768) >> 16; T.senseDy[a] = (sin[a] * sensePx + 32768) >> 16;
  }
  return T;
}

function isqrtBig(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
const isqrtNum = (n) => Number(isqrtBig(BigInt(n)));

// spore: { seed: Uint8Array(32), age: number, edges: [[id:number, d:bigint|number]] }
function normalize(sp) {
  const edges = sp.edges.map(([i, d]) => [i, BigInt(d)]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { seed: sp.seed, age: sp.age, edges };
}
const dn1000 = (d) => Number((d < 1000000n ? d : 1000000n) / 1000n);
function ringPos(T, id, r) {
  const a = ((id & 63) * 64 + TURN - 1024) & MASK;
  return [C + ((r * T.cos(a)) >> 16), C + ((r * T.sin[a]) >> 16)];
}
const boundR = (deg) => Math.min(BOUND_MAX, 140 + 10 * deg);
function nodesOf(sp, T) {
  let rep = 0n;
  for (const [, d] of sp.edges) rep += isqrtBig(d);
  const bonus = Number(rep * 256n / 3500n > 512n ? 512n : rep * 256n / 3500n);
  const v = [{ x: C, y: C, st: 1075 + bonus }];
  for (const [id, d] of sp.edges) {
    const dn = dn1000(d);
    const [x, y] = ringPos(T, id, Math.min(RING_R - Math.floor(84 * dn / 1000), boundR(sp.edges.length) - 12));
    v.push({ x, y, st: 410 + Math.floor(410 * dn / 1000) });
  }
  return v;
}

export function simulate(spIn, T = tables(2, 11)) {
  const sp = normalize(spIn);
  let trail = new Int32Array(N * N);
  if (sp.edges.length === 0) return trail;
  const rnd = rngFrom(sp.seed.subarray(0, 16));
  const nodes = nodesOf(sp, T);
  const deg = sp.edges.length;
  const bound = boundR(deg), initR = BigInt(Math.floor(bound * 95 / 100));
  const nA = Math.min(26000, 3300 + 2300 * deg), steps = Math.min(600, 150 + 22 * deg);
  const ax = new Int32Array(nA), ay = new Int32Array(nA), ah = new Int32Array(nA);
  for (let i = 0; i < nA; i++) {
    const ang = rnd() & MASK;
    const u1 = rnd() >>> 16, u2 = rnd() >>> 16;
    const r = Number((initR * BigInt(u1) * BigInt(u2)) >> 32n);
    ax[i] = (C + ((r * T.cos(ang)) >> 16)) << 16;
    ay[i] = (C + ((r * T.sin[ang]) >> 16)) << 16;
    ah[i] = rnd() & MASK;
  }
  let next = new Int32Array(N * N);
  const cl = (v) => (v < 0 ? 0 : v > N - 1 ? N - 1 : v);
  for (let s = 0; s < steps; s++) {
    for (const nd of nodes) {
      for (let y = Math.max(0, nd.y - NODE_R); y <= Math.min(N - 1, nd.y + NODE_R); y++)
        for (let x = Math.max(0, nd.x - NODE_R); x <= Math.min(N - 1, nd.x + NODE_R); x++)
          if ((x - nd.x) ** 2 + (y - nd.y) ** 2 <= NODE_R * NODE_R) {
            const o = y * N + x; trail[o] = Math.min(CAP, trail[o] + nd.st);
          }
    }
    for (let i = 0; i < nA; i++) {
      let h = ah[i];
      const px = ax[i] >> 16, py = ay[i] >> 16;
      const f = trail[cl(py + T.senseDy[h]) * N + cl(px + T.senseDx[h])];
      const hl = (h + TURN - SA) & MASK, hr = (h + SA) & MASK;
      const l = trail[cl(py + T.senseDy[hl]) * N + cl(px + T.senseDx[hl])];
      const r = trail[cl(py + T.senseDy[hr]) * N + cl(px + T.senseDx[hr])];
      const right = (rnd() & 1) === 1;
      if (f < l && f < r) h = right ? h + TU : h + TURN - TU;
      else if (l > f && l > r) h = h + TURN - TU;
      else if (r > f && r > l) h += TU;
      h &= MASK;
      const nx = ax[i] + T.stepDx[h], ny = ay[i] + T.stepDy[h];
      const qx = nx >> 16, qy = ny >> 16;
      if ((qx - C) * (qx - C) + (qy - C) * (qy - C) > bound * bound) h = rnd() & MASK;
      else { ax[i] = nx; ay[i] = ny; }
      ah[i] = h;
      const o = (ay[i] >> 16) * N + (ax[i] >> 16);
      trail[o] = Math.min(CAP, trail[o] + 256);
    }
    for (let y = 0; y < N; y++) {
      const y0 = cl(y - 1) * N, y1 = y * N, y2 = cl(y + 1) * N;
      for (let x = 0; x < N; x++) {
        const x0 = cl(x - 1), x2 = cl(x + 1);
        const blur16 = trail[y0 + x0] + 2 * trail[y0 + x] + trail[y0 + x2] + 2 * trail[y1 + x0] + 4 * trail[y1 + x] + 2 * trail[y1 + x2] + trail[y2 + x0] + 2 * trail[y2 + x] + trail[y2 + x2];
        next[y1 + x] = Math.floor((trail[y1 + x] * 880 + blur16 * 45) * 90 / 160000);
      }
    }
    [trail, next] = [next, trail];
  }
  return trail;
}

// ---- paint ----
const STOPS_POS = [0, 41, 107, 184, 235, 255];
const PALETTES = [
  [[6, 9, 8], [8, 62, 60], [24, 150, 120], [240, 196, 60], [255, 236, 170], [255, 255, 240]],
  [[10, 6, 6], [70, 10, 14], [190, 40, 24], [255, 140, 30], [255, 214, 140], [255, 250, 235]],
  [[7, 5, 14], [40, 16, 92], [120, 40, 200], [240, 90, 200], [255, 190, 235], [255, 248, 255]],
  [[5, 9, 6], [10, 70, 30], [60, 180, 50], [200, 240, 60], [240, 255, 170], [252, 255, 238]],
  [[4, 8, 14], [8, 50, 100], [20, 130, 210], [70, 220, 230], [190, 250, 250], [245, 255, 255]],
];
const AGE_FULL = 30, MASK_MAX = 14, BLOOM_R = 6;

function paletteLut(p) {
  const st = PALETTES[p], lut = [];
  for (let i = 0; i < 256; i++) {
    let k = 0;
    while (k < 4 && i > STOPS_POS[k + 1]) k++;
    const t0 = STOPS_POS[k], span = STOPS_POS[k + 1] - t0;
    lut.push([0, 1, 2].map((j) => Math.floor((st[k][j] * span + (st[k + 1][j] - st[k][j]) * (i - t0)) / span)));
  }
  return lut;
}

function boxBlur(src, r) {
  const w = 2 * r + 1, tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  const cl = (v) => (v < 0 ? 0 : v > N - 1 ? N - 1 : v);
  for (let ch = 0; ch < 3; ch++) {
    for (let y = 0; y < N; y++) {
      const px = (x) => src[(y * N + cl(x)) * 3 + ch];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += px(k);
      for (let x = 0; x < N; x++) { tmp[(y * N + x) * 3 + ch] = Math.floor(sum / w); sum += px(x + r + 1) - px(x - r); }
    }
    for (let x = 0; x < N; x++) {
      const px = (y) => tmp[(cl(y) * N + x) * 3 + ch];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += px(k);
      for (let y = 0; y < N; y++) { out[(y * N + x) * 3 + ch] = Math.floor(sum / w); sum += px(y + r + 1) - px(y - r); }
    }
  }
  return out;
}

export function render(spIn, T = tables(2, 11)) {
  const sp = normalize(spIn);
  return paint(sp, simulate(sp, T), T);
}

function paint(sp, trail, T) {
  const deg = sp.edges.length, pal = sp.seed[31] % 5, lut = paletteLut(pal), accent = PALETTES[pal][3];
  const tone = Array.from({ length: 256 }, (_, i) => Math.floor((3 * i + isqrtNum(i * 255)) / 4));
  const age = Math.min(sp.age, AGE_FULL), mask = MASK_MAX - Math.floor(MASK_MAX * age / AGE_FULL);
  let img = new Uint8Array(N * N * 3);
  for (let i = 0; i < trail.length; i++) {
    const v = Math.min(255, Math.floor(trail[i] * 255 / (24 * 256)));
    const c = lut[v < mask ? 0 : tone[v]];
    img[i * 3] = c[0]; img[i * 3 + 1] = c[1]; img[i * 3 + 2] = c[2];
  }
  const bloom = boxBlur(boxBlur(img, BLOOM_R), BLOOM_R);
  for (let i = 0; i < img.length; i++) {
    const bb = Math.floor(bloom[i] * 55 / 100);
    img[i] = 255 - Math.floor((255 - img[i]) * (255 - bb) / 255);
  }
  const grng = rngFrom(sp.seed.subarray(16, 32));
  const d2max = Math.floor(N * 72 / 100) ** 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = grng();
    const noise = ((u >>> 29) & 7) + ((u >>> 26) & 7) - 7;
    const d2 = (x - C) * (x - C) + (y - C) * (y - C);
    const m = Math.min(256, Math.max(51, 287 - Math.floor(256 * d2 / d2max)));
    const o = (y * N + x) * 3;
    for (let j = 0; j < 3; j++) img[o + j] = Math.floor(Math.min(255, Math.max(0, img[o + j] + noise)) * m / 256);
  }
  const blend = (x, y, col, alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= N || y >= N) return;
    const o = (y * N + x) * 3;
    for (let j = 0; j < 3; j++) img[o + j] = Math.floor((img[o + j] * (255 - alpha) + col[j] * alpha) / 255);
  };
  const dist16 = (x, y, cx, cy) => isqrtNum(256 * ((x - cx) * (x - cx) + (y - cy) * (y - cy)));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const disc = (cx, cy, r16, col, alpha) => {
    const m = Math.floor(r16 / 16) + 2;
    for (let y = cy - m; y <= cy + m; y++) for (let x = cx - m; x <= cx + m; x++)
      blend(x, y, col, Math.floor(alpha * clamp(r16 - dist16(x, y, cx, cy) + 8, 0, 16) / 16));
  };
  const ring = (cx, cy, r16, w16, col, alpha) => {
    const m = Math.floor((r16 + w16) / 16) + 2;
    for (let y = cy - m; y <= cy + m; y++) for (let x = cx - m; x <= cx + m; x++)
      blend(x, y, col, Math.floor(alpha * clamp(Math.floor(w16 / 2) + 8 - Math.abs(dist16(x, y, cx, cy) - r16), 0, 16) / 16));
  };
  const has = new Set(sp.edges.map((e) => e[0] & 63));
  for (let i = 0; i < 64; i++) if (!has.has(i)) { const [x, y] = ringPos(T, i, RING_R); disc(x, y, 20, [150, 160, 155], 70); }
  for (let k = 0; k < 140; k++) {
    const x = grng() % N, y = grng() % N, r16 = 16 + (grng() % 32), a = 25 + (grng() % 66);
    disc(x, y, r16, [255, 255, 255], a);
  }
  const ns = nodesOf(sp, T);
  for (let k = 1; k < ns.length; k++) {
    const nd = ns[k], r0 = 90 + Math.floor(66 * dn1000(sp.edges[k - 1][1]) / 1000);
    ring(nd.x, nd.y, r0 + 74, 16, accent, 90);
    disc(nd.x, nd.y, r0, [6, 8, 8], 200);
    ring(nd.x, nd.y, r0, 24, accent, 255);
    disc(nd.x, nd.y, 29, [255, 250, 235], 255);
  }
  const glow = deg === 0 ? 70 : 200, rg2 = 1600;
  for (let y = C - 40; y <= C + 40; y++) for (let x = C - 40; x <= C + 40; x++) {
    const d2 = (x - C) * (x - C) + (y - C) * (y - C);
    if (d2 < rg2) { const q = rg2 - d2; blend(x, y, accent, Math.floor(glow * q * q / (rg2 * rg2))); }
  }
  if (deg > 0) { disc(C, C, 106, [255, 252, 240], 255); ring(C, C, 160, 16, [255, 252, 240], 200); }
  else disc(C, C, 56, accent, 150);
  const e = N / 2 - 9;
  for (let k = -e; k <= e; k++) for (const [x, y] of [[C + k, C - e], [C + k, C + e], [C - e, C + k], [C + e, C + k]]) blend(x, y, [255, 255, 255], 40);
  return img;
}

// ---- hashes (same framing as the Rust crate) ----
const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
export const imageHash = (rgb) => createHash('sha256').update('spores/img/v1').update(u32le(RENDERER_VERSION)).update(u32le(N)).update(u32le(N)).update(rgb).digest('hex');
export const trailHash = (trail) => createHash('sha256').update('spores/trail/v1').update(Buffer.from(trail.buffer, trail.byteOffset, trail.byteLength)).digest('hex');
export const sinTableHash = () => { const t = sinTable(); return createHash('sha256').update('spores/sin/v1').update(Buffer.from(t.buffer)).digest('hex'); };
