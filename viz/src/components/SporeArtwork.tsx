// A spore's art from its render input only (Design §7): the on-chain glyph
// (real data) shows until the worker returns pixels and hash, then the image
// crossfades in. The previous image stays until the next one is complete;
// there is no progressive render and no shimmer. Takes Organism data only.
import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Organism } from '../model/types';
import { hex, paletteOf } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';
import { RenderQueueContext } from '../wasm/art';
import { N, rgbToRgba } from '../wasm/renderer';

export type ArtworkVariant = 'full' | 'card' | 'thumb';
export type ArtworkState = 'glyph' | 'ready' | 'error';

export type ArtworkOrganism = Pick<Organism, 'id' | 'seed' | 'age' | 'tubes'>;

/** "Spore #7 artwork: violet palette, 4 tubes, strongest to #3" (Design §9). */
export function artworkLabel(o: ArtworkOrganism): string {
  const pal = paletteOf(o.seed).name;
  if (o.tubes.length === 0) return `Spore #${o.id} artwork: ${pal} palette, no tubes`;
  const strongest = o.tubes.reduce((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? b : a));
  const n = o.tubes.length;
  return `Spore #${o.id} artwork: ${pal} palette, ${n} tube${n === 1 ? '' : 's'}, strongest to #${strongest[0]}`;
}

/** Everything the image depends on (seed, age, tubes); a new key starts a new render. */
export function artKey(o: ArtworkOrganism): string {
  return `${o.seed}|${o.age}|${o.tubes.map(([n, d]) => `${n}:${d}`).join(',')}`;
}

export function SporeArtwork({
  organism,
  glyph,
  variant = 'card',
  priority = 1,
  onRendered,
  onFailed,
}: {
  organism: ArtworkOrganism;
  /** NEP-177 `media`: the on-chain SVG glyph data URI. */
  glyph?: string | null;
  variant?: ArtworkVariant;
  /** Lower renders first; the component lowers it to 0 once it is on screen. */
  priority?: number;
  /** Called with the image hash of each image shown (the gallery compares it with the commit). */
  onRendered?: (r: { key: string; imageHash: string; rendererVersion: number; source: 'cache' | 'worker' }) => void;
  /** Called when the render for `key` failed (the glyph stays). */
  onFailed?: (r: { key: string; error: string }) => void;
}) {
  const getQueue = useContext(RenderQueueContext);
  const [state, setState] = useState<ArtworkState>('glyph');
  const [error, setError] = useState<string | null>(null);
  const [front, setFront] = useState<0 | 1 | null>(null);
  const root = useRef<HTMLElement>(null);
  const canvasA = useRef<HTMLCanvasElement>(null);
  const canvasB = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<0 | 1 | null>(null);
  const report = useRef({ onRendered, onFailed });
  report.current = { onRendered, onFailed };
  const latest = useRef({ getQueue, priority });
  latest.current = { getQueue, priority };

  const key = artKey(organism);

  useEffect(() => {
    const ctrl = new AbortController();
    let done = false;
    const input = { seed: organism.seed, age: organism.age, edges: organism.tubes };
    const show = (rgb: Uint8Array, imageHash: string, rendererVersion: number, source: 'cache' | 'worker') => {
      if (done || ctrl.signal.aborted) return;
      done = true;
      const back: 0 | 1 = frontRef.current === 0 ? 1 : 0;
      const ctx = (back === 0 ? canvasA : canvasB).current?.getContext('2d');
      if (ctx) ctx.putImageData(new ImageData(rgbToRgba(rgb), N, N), 0, 0);
      frontRef.current = back;
      setFront(back);
      setState('ready');
      setError(null);
      report.current.onRendered?.({ key, imageHash, rendererVersion, source });
    };
    const fail = (e: unknown) => {
      if (ctrl.signal.aborted || (e as Error)?.name === 'AbortError') return;
      const message = String((e as Error)?.message ?? e);
      setError(message);
      if (frontRef.current === null) setState('error');
      report.current.onFailed?.({ key, error: message });
    };
    const ask = (p: number) =>
      latest.current
        .getQueue()
        .then((q) => q.request(input, { priority: p, signal: ctrl.signal }))
        .then((r) => show(r.rgb, r.imageHash, r.rendererVersion, r.source), fail);

    void ask(latest.current.priority);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function' && root.current) {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && !done) {
          io?.disconnect();
          void ask(0);
        }
      });
      io.observe(root.current);
    }
    return () => {
      io?.disconnect();
      ctrl.abort();
    };
  }, [key]); // `key` covers seed, age and tubes; the queue and priority are read through `latest`

  return (
    <figure
      className={`artwork artwork-${variant}`}
      data-state={state}
      ref={root}
      style={{ '--accent': hex(paletteOf(organism.seed).stops[3]) } as CSSProperties}
    >
      <div className="artwork-frame" role="img" aria-label={artworkLabel(organism)} aria-busy={state === 'glyph'}>
        {glyph ? <img className="artwork-glyph" src={glyph} alt="" /> : <div className="artwork-glyph" />}
        <canvas ref={canvasA} width={N} height={N} className={`artwork-canvas${front === 0 ? ' is-front' : ''}`} aria-hidden="true" />
        <canvas ref={canvasB} width={N} height={N} className={`artwork-canvas${front === 1 ? ' is-front' : ''}`} aria-hidden="true" />
      </div>
      {state !== 'ready' && variant !== 'thumb' && (
        <figcaption className="mono-s artwork-caption">
          {state === 'error' ? (
            <Tooltip content={<span className="mono">{error}</span>}>{glyph ? 'Could not render · glyph shown' : 'Could not render'}</Tooltip>
          ) : glyph ? (
            'on-chain glyph · rendering…'
          ) : (
            'rendering…'
          )}
        </figcaption>
      )}
    </figure>
  );
}
