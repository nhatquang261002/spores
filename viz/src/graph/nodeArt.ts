// The spore's own art on its node (user 2026-11-04: "the node is the spore
// (NFT) visually"; then "I want the spore as the visual and its tube is the
// tube, not just the spore inside the ring"). Same input as the inspector
// thumb: the spore's current seed, age and live tubes, so a node shows the NFT
// as it is now, at every frame. The whole organism shows, with no disc or
// ring: the art's dark ground is keyed out (alpha from brightness) and its
// square edge fades out, so the body sits on the dish and the map's tubes
// can leave from the art's own partner discs (model/network.ts `tubeCurve`). The on-chain glyph shows until the worker returns pixels (Design §7);
// an image stays until the next one is complete. Renders queue behind
// anything on screen (priority 3) and come from the image cache after that.
import { useContext, useEffect, useRef, useState } from 'react';
import { RenderQueueContext } from '../wasm/art';
import { N, rgbToRgba, type RenderInput } from '../wasm/renderer';

/** Side of the keyed image the map draws (the whole 512 px art). */
export const ART_PX = 256;
/** Brightness (max channel, 0–255) where the key starts and where it is opaque; below KEY_LO is the art's ground, grain and far bloom. */
const KEY_LO = 40;
const KEY_HI = 140;
/** The square edge fades out between these shares of the half side (the body reaches 215/256 at most; the frame sits at 247). */
const FADE_IN = 0.8;
const FADE_OUT = 0.92;

export interface NodeArtInput {
  id: number;
  /** The spore's current render input; null when the source has no age. */
  input: RenderInput | null;
  /** NEP-177 `media`: the on-chain SVG glyph data URI. */
  glyph: string | null;
}

export const inputKey = (r: RenderInput) => `${r.seed}|${r.age}|${r.edges.map(([n, d]) => `${n}:${d}`).join(',')}`;

/** Alpha for one pixel: brightness key times the round fade. Colours are left as rendered. */
export function keyAlpha(r: number, g: number, b: number, dist: number): number {
  const k = Math.min(1, Math.max(0, (Math.max(r, g, b) - KEY_LO) / (KEY_HI - KEY_LO)));
  const f = Math.min(1, Math.max(0, (FADE_OUT - dist) / (FADE_OUT - FADE_IN)));
  // Squared, so the bloom's low wash fades out instead of leaving the square's haze.
  return k * k * f;
}

function downscale(rgb: Uint8Array): HTMLCanvasElement | null {
  const full = document.createElement('canvas');
  full.width = N;
  full.height = N;
  const small = document.createElement('canvas');
  small.width = ART_PX;
  small.height = ART_PX;
  const f = full.getContext('2d');
  const s = small.getContext('2d');
  if (!f || !s) return null;
  f.putImageData(new ImageData(rgbToRgba(rgb), N, N), 0, 0);
  s.imageSmoothingQuality = 'high';
  s.drawImage(full, 0, 0, N, N, 0, 0, ART_PX, ART_PX);
  const img = s.getImageData(0, 0, ART_PX, ART_PX);
  const px = img.data;
  const half = ART_PX / 2;
  for (let y = 0; y < ART_PX; y++)
    for (let x = 0; x < ART_PX; x++) {
      const o = (y * ART_PX + x) * 4;
      const dist = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      px[o + 3] = Math.round(255 * keyAlpha(px[o], px[o + 1], px[o + 2], dist));
    }
  s.putImageData(img, 0, 0);
  return small;
}

/** id → the image to draw on the node (glyph, then the rendered art). */
export function useNodeArt(items: NodeArtInput[]): Map<number, CanvasImageSource> {
  const getQueue = useContext(RenderQueueContext);
  const [art, setArt] = useState(() => new Map<number, CanvasImageSource>());
  // id → what is shown: 'glyph' or the render key.
  const shown = useRef(new Map<number, string>());
  const latest = useRef({ items, getQueue });
  latest.current = { items, getQueue };
  const sig = items.map((i) => `${i.id}/${i.input ? inputKey(i.input) : ''}/${i.glyph ? i.glyph.length : 0}`).join(';');

  useEffect(() => {
    const ctrl = new AbortController();
    const put = (id: number, img: CanvasImageSource, what: string) => {
      if (ctrl.signal.aborted) return;
      shown.current.set(id, what);
      setArt((m) => new Map(m).set(id, img));
    };
    for (const it of latest.current.items) {
      const key = it.input ? inputKey(it.input) : null;
      if (key !== null && shown.current.get(it.id) === key) continue;
      if (it.glyph && !shown.current.has(it.id) && typeof Image === 'function') {
        const img = new Image();
        img.onload = () => {
          if (!shown.current.has(it.id)) put(it.id, img, 'glyph');
        };
        img.src = it.glyph;
      }
      if (!it.input || key === null) continue;
      const input = it.input;
      latest.current
        .getQueue()
        .then((q) => q.request(input, { priority: 3, signal: ctrl.signal }))
        .then(
          (r) => {
            const img = downscale(r.rgb);
            if (img) put(it.id, img, key);
          },
          () => {
            // No worker or the render failed: the glyph (or the plain node) stays, as on the cards.
          },
        );
    }
    return () => ctrl.abort();
  }, [sig]); // `sig` covers every id, input and glyph; the items and the queue are read through `latest`

  return art;
}
