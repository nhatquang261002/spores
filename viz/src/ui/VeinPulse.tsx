// Epoch pulse (Design §3.5): when a close is observed (`epoch_info.epoch`
// went up since the last poll), a bead of yolk runs along the top bar's vein
// both ways from the epoch clock, like cytoplasm streaming out of the nucleus.
// It never starts on a guess: no pulse on first load, on a source switch or
// when the epoch goes down. Decorative (aria-hidden); off under reduced motion.
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/** Counts observed rises of `value`. The first value seen, and any fall, don't count. */
export function useRiseCount(value: number | null | undefined): number {
  const last = useRef<number | null>(null);
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    if (value == null) return;
    if (last.current !== null && value > last.current) setCount((c) => c + 1);
    last.current = value;
  }, [value]);
  return count;
}

export function VeinPulse({
  epoch,
  reducedMotion,
  container,
}: {
  epoch: number | null | undefined;
  reducedMotion: boolean;
  /** The top bar; the pulse starts under its `.epoch-clock`. */
  container: RefObject<HTMLElement | null>;
}) {
  const pulses = useRiseCount(epoch);
  const [originX, setOriginX] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (pulses === 0) return;
    const bar = container.current;
    const clock = bar?.querySelector('.epoch-clock');
    if (!bar || !clock) return setOriginX(null);
    const b = bar.getBoundingClientRect();
    const c = clock.getBoundingClientRect();
    setOriginX(c.left + c.width / 2 - b.left);
  }, [pulses, container]);
  if (pulses === 0 || reducedMotion || originX === null) return null;
  const style = { '--pulse-x': `${Math.round(originX)}px` } as CSSProperties;
  // `key` remounts the spans, so every close restarts the animation.
  return (
    <span className="vein-pulse" key={pulses} style={style} aria-hidden="true" data-testid="vein-pulse">
      <span className="vein-pulse-left" />
      <span className="vein-pulse-right" />
    </span>
  );
}
