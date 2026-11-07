// The epoch timeline under the map (Design §6.C, §7 `EpochScrubber`): a tick
// per epoch from 1 to the current one, each a real bar of that epoch's flows;
// hollow where the source has no close for that epoch. One slider for
// keyboard and screen readers (←/→, Home/End), drag on the track, ▶︎ play,
// and a button back to Live (the run's end for LOCAL RUN / RECORDED).
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Keeps a drag on this element; a pointer the browser no longer tracks can't be captured, which is fine. */
function capture(el: Element, id: number) {
  try {
    el.setPointerCapture?.(id);
  } catch {
    // not an active pointer
  }
}

export interface ScrubTick {
  epoch: number;
  /** Flows that epoch; null = no history in this source. */
  flows: number | null;
  /** The tube set is known for this epoch. */
  tubes: boolean;
}

export function tickTip(t: ScrubTick, current: number, endWord: string, flowsWord: string): string {
  const head = t.epoch === current ? `${endWord} · epoch ${t.epoch}` : `Epoch ${t.epoch}`;
  if (t.flows === null && !t.tubes) return `${head} · No close tx for epoch ${t.epoch} in this source`;
  if (t.flows === null) return `${head} · tubes known; flows need the close tx for epoch ${t.epoch}`;
  return `${head} · ${t.flows} ${flowsWord}${t.flows === 1 ? '' : 's'}${t.tubes ? '' : ' · tubes unknown'}`;
}

export function EpochScrubber({
  ticks,
  position,
  current,
  endWord,
  flowsWord,
  playing,
  onChange,
  onPlay,
  onLive,
}: {
  ticks: ScrubTick[];
  position: number;
  current: number;
  /** `Live` for LIVE, `End` for a run. */
  endWord: string;
  /** What a bar counts: `flow` (chain pairs) or `settled job` (run log). */
  flowsWord: string;
  playing: boolean;
  onChange: (epoch: number) => void;
  onPlay: () => void;
  onLive: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hoverEpoch, setHoverEpoch] = useState<number | null>(null);
  const dragging = useRef(false);
  const max = Math.max(1, ...ticks.map((t) => t.flows ?? 0));
  const first = ticks[0]?.epoch ?? 1;

  const epochAt = (clientX: number) => {
    const b = track.current!.getBoundingClientRect();
    const i = Math.floor(((clientX - b.left) / Math.max(1, b.width)) * ticks.length);
    return ticks[Math.max(0, Math.min(ticks.length - 1, i))]?.epoch ?? current;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    capture(e.target as Element, e.pointerId);
    onChange(epochAt(e.clientX));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const ep = epochAt(e.clientX);
    setHoverEpoch(ep);
    if (dragging.current && ep !== position) onChange(ep);
  };
  const up = () => {
    dragging.current = false;
  };
  const key = (e: KeyboardEvent) => {
    const to: Record<string, number> = { ArrowLeft: position - 1, ArrowDown: position - 1, ArrowRight: position + 1, ArrowUp: position + 1, Home: first, End: current };
    if (!(e.key in to)) return;
    e.preventDefault();
    onChange(Math.max(first, Math.min(current, to[e.key])));
  };

  const shown = ticks.find((t) => t.epoch === (hoverEpoch ?? position));
  return (
    <div className="scrubber">
      <button type="button" className="btn btn-secondary scrub-play" onClick={onPlay} aria-pressed={playing} aria-label={playing ? 'Pause' : 'Play epochs'}>
        <span aria-hidden="true">{playing ? '❚❚' : '▶︎'}</span>
      </button>
      <div className="scrub-main">
        <div
          className="scrub-track"
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Epoch"
          aria-valuemin={first}
          aria-valuemax={current}
          aria-valuenow={position}
          aria-valuetext={shown ? tickTip(shown, current, endWord, flowsWord) : `Epoch ${position}`}
          onKeyDown={key}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={() => setHoverEpoch(null)}
        >
          {ticks.map((t) => (
            <span
              key={t.epoch}
              className={`scrub-tick${t.flows === null ? ' is-hollow' : ''}${t.epoch === position ? ' is-current' : ''}${t.epoch === current ? ' is-live' : ''}`}
              data-epoch={t.epoch}
            >
              <span className="scrub-bar" style={{ height: `${t.flows === null ? 36 : Math.max(8, Math.round((t.flows / max) * 100))}%` }} />
            </span>
          ))}
        </div>
        <div className="scrub-readout mono-s" aria-hidden="true">
          <span>E {first}</span>
          <span className="scrub-readout-mid">{shown ? tickTip(shown, current, endWord, flowsWord) : ''}</span>
          <span>{endWord}</span>
        </div>
      </div>
      <button type="button" className="btn btn-secondary scrub-live" onClick={onLive} aria-pressed={position === current}>
        {endWord}
      </button>
    </div>
  );
}
