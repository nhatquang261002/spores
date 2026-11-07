// Attacker vs honest, per epoch (Design §6.H; dataviz method): two series, one
// axis, attacker in `--warn` and honest in `--text-2`, both dashed because this is
// a simulation (§4.1), with a direct label at each line's end and no legend box.
// Identity is never colour alone: the dash patterns differ and each line is named.
// Hover (or tap) reads any epoch; every value is also in the table below the panel.
import { useEffect, useRef, useState } from 'react';

const M = { top: 12, right: 132, bottom: 26, left: 30 };
const M_NARROW = { top: 12, right: 12, bottom: 26, left: 26 };
const DASH = { attacker: '7 4', honest: '2 4' };
/** Minimum px between the two end labels. */
const LABEL_GAP = 34;

function linePath(values: number[], upto: number, x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  const whole = Math.floor(upto);
  for (let i = 0; i <= whole && i < values.length; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(values[i]).toFixed(1)}`;
  if (whole + 1 < values.length && upto > whole) {
    const f = upto - whole;
    const v = values[whole] + (values[whole + 1] - values[whole]) * f;
    d += `L${x(whole + f).toFixed(1)} ${y(v).toFixed(1)}`;
  }
  return d;
}

const valueAt = (values: number[], at: number) => {
  const i = Math.min(values.length - 1, Math.floor(at));
  const f = at - i;
  return i + 1 < values.length ? values[i] + (values[i + 1] - values[i]) * f : values[i];
};

/** Keeps two labels readable when the lines come close: the higher value stays on top. */
export function spreadLabels(a: number, b: number, gap: number): [number, number] {
  if (Math.abs(a - b) >= gap) return [a, b];
  const mid = (a + b) / 2;
  return a <= b ? [mid - gap / 2, mid + gap / 2] : [mid + gap / 2, mid - gap / 2];
}

export function WashChart({ attacker, honest, top, at, title }: { attacker: number[]; honest: number[]; top: number; /** Epoch index reached, fractional. */ at: number; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = w < 420;
  const m = narrow ? M_NARROW : M;
  const h = narrow ? 240 : Math.max(280, Math.min(420, Math.round(w * 0.62)));
  const n = attacker.length;
  const x = (i: number) => m.left + (i / Math.max(1, n - 1)) * (w - m.left - m.right);
  const y = (v: number) => m.top + (1 - v / top) * (h - m.top - m.bottom);
  const reached = Math.min(n - 1, Math.max(0, at));
  const nowA = valueAt(attacker, reached);
  const nowH = valueAt(honest, reached);
  const ticks = Array.from({ length: top + 1 }, (_, i) => i).filter((v) => top <= 6 || v % 2 === 0);
  const [labelA, labelH] = spreadLabels(y(nowA), y(nowH), LABEL_GAP);
  const window = Math.floor(n / 2);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const u = (e.clientX - b.left) / Math.max(1, b.width);
    setHover(Math.max(0, Math.min(n - 1, Math.round(u * (n - 1)))));
  };

  return (
    <div className="wash-chart" ref={box}>
      <svg width={w} height={h} role="img" aria-label={`${title}. At epoch ${Math.round(reached) + 1} the attacker's best spore has R ${nowA.toFixed(2)} and the honest median is ${nowH.toFixed(2)}.`}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="wc-grid" x1={m.left} x2={w - m.right} y1={y(v)} y2={y(v)} />
            <text className="wc-tick" x={m.left - 8} y={y(v) + 4} textAnchor="end">{v}</text>
          </g>
        ))}
        <line className="wc-window" x1={x(window)} x2={x(window)} y1={m.top} y2={h - m.bottom} />
        {!narrow && <text className="wc-tick" x={x(window) + 6} y={m.top + 10}>the gate measures from here</text>}
        {[0, window, n - 1].map((i) => (
          <text key={i} className="wc-tick" x={x(i)} y={h - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{i === 0 ? 'epoch 1' : i + 1}</text>
        ))}
        <path className="wc-honest" d={linePath(honest, reached, x, y)} strokeDasharray={DASH.honest} />
        <path className="wc-attacker" d={linePath(attacker, reached, x, y)} strokeDasharray={DASH.attacker} />
        <circle className="wc-head wc-head-honest" cx={x(reached)} cy={y(nowH)} r={4.5} />
        <circle className="wc-head wc-head-attacker" cx={x(reached)} cy={y(nowA)} r={4.5} />
        {!narrow && (
          <>
            <g transform={`translate(${x(reached) + 10} ${labelA})`}>
              <text className="wc-end" y={-2}>attacker’s best</text>
              <text className="wc-end wc-end-n" y={12}>R {nowA.toFixed(2)}</text>
            </g>
            <g transform={`translate(${x(reached) + 10} ${labelH})`}>
              <text className="wc-end" y={-2}>honest median</text>
              <text className="wc-end wc-end-n" y={12}>R {nowH.toFixed(2)}</text>
            </g>
          </>
        )}
        {hover !== null && (
          <>
            <line className="wc-cross" x1={x(hover)} x2={x(hover)} y1={m.top} y2={h - m.bottom} />
            <circle className="wc-head wc-head-honest" cx={x(hover)} cy={y(honest[hover])} r={3.5} />
            <circle className="wc-head wc-head-attacker" cx={x(hover)} cy={y(attacker[hover])} r={3.5} />
          </>
        )}
        <rect x={m.left} y={m.top} width={Math.max(1, w - m.left - m.right)} height={Math.max(1, h - m.top - m.bottom)} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {narrow && (
        <p className="mono-s wc-key">
          <span className="wc-swatch wc-swatch-attacker" aria-hidden="true" /> attacker’s best R {nowA.toFixed(2)} <span className="wc-swatch wc-swatch-honest" aria-hidden="true" /> honest median R {nowH.toFixed(2)}
        </p>
      )}
      {hover !== null && (
        <div className="wc-tip mono-s" style={{ left: `${(x(hover) / w) * 100}%` }} role="status">
          <span>epoch {hover + 1}</span>
          <span>attacker {attacker[hover].toFixed(3)}</span>
          <span>honest {honest[hover].toFixed(3)}</span>
        </div>
      )}
    </div>
  );
}
