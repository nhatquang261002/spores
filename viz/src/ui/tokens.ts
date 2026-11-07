// Typed copy of tokens.css for canvas code, which can't read CSS variables
// cheaply per frame. Keep the two files in step (test/tokens.test.ts checks it).

export const color = {
  bg: '#0a0f0b',
  surface: '#111913',
  surface2: '#17211a',
  surface3: '#1d2a21',
  line: '#2a3a2e',
  lineStrong: '#66796b',
  text: '#eef2e4',
  text2: '#b2bda8',
  text3: '#87947f',
  artBg: '#06090a',
  slime: '#e8c547',
  growth: '#8fe36b',
  agent: '#9b8cff',
  value: '#f2a65a',
  warn: '#f06d78',
  caution: '#f2a65a',
} as const;

export type Rgb = readonly [number, number, number];

export interface Palette {
  idx: number;
  name: 'yolk' | 'ember' | 'violet' | 'toxic' | 'aqua';
  /** Six stops; stop 3 is the accent (partner rings, nucleus glow). */
  stops: readonly [Rgb, Rgb, Rgb, Rgb, Rgb, Rgb];
}

/** Copied from renderer/src/paint.rs `PALETTES`. Do not hand-tune. */
export const palettes: readonly Palette[] = [
  { idx: 0, name: 'yolk', stops: [[6, 9, 8], [8, 62, 60], [24, 150, 120], [240, 196, 60], [255, 236, 170], [255, 255, 240]] },
  { idx: 1, name: 'ember', stops: [[10, 6, 6], [70, 10, 14], [190, 40, 24], [255, 140, 30], [255, 214, 140], [255, 250, 235]] },
  { idx: 2, name: 'violet', stops: [[7, 5, 14], [40, 16, 92], [120, 40, 200], [240, 90, 200], [255, 190, 235], [255, 248, 255]] },
  { idx: 3, name: 'toxic', stops: [[5, 9, 6], [10, 70, 30], [60, 180, 50], [200, 240, 60], [240, 255, 170], [252, 255, 238]] },
  { idx: 4, name: 'aqua', stops: [[4, 8, 14], [8, 50, 100], [20, 130, 210], [70, 220, 230], [190, 250, 250], [245, 255, 255]] },
];

/** The renderer's palette choice: `seed[31] % 5` (renderer/src/paint.rs). `seedHex` is 64 hex chars. */
export function paletteOf(seedHex: string): Palette {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error(`not a 32-byte hex seed: ${seedHex}`);
  return palettes[parseInt(seedHex.slice(62, 64), 16) % 5];
}

export const hex = (c: Rgb): string => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/** Durations in ms (§3.5); all 0 under reduced motion. `grow` and `pulse` are the slime-theme `--t-grow` and `--t-pulse`;
 * `stream` and `breathe` (`--t-stream`, `--t-breathe`) pace the ambient motions, which reduced motion switches off. */
export const motion = { micro: 120, ui: 200, panel: 320, art: 480, epoch: 900, grow: 1200, pulse: 1600, stream: 45000, breathe: 6000 } as const;

export const breakpoint = { sm: 640, md: 900, lg: 1200, xl: 1480 } as const;
