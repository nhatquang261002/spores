// "Table view" (Design §6.C, §9): every node and tube on the map, as two
// sortable tables with the same selection as the canvas.
import { useMemo, useState } from 'react';
import type { Selection } from '../graph/draw';
import { pairKey, pairOf, tubesOf, type Frame, type FrameDiff, type PairKey, type TubeChange } from '../model/network';
import { formatNear, formatR } from '../ui/format';
import { palettes } from '../ui/tokens';
import { formatD, SporeRef } from './indicators';

type SporeSort = 'id' | 'r' | 'degree';
type TubeSort = 'pair' | 'd' | 'change';

const CHANGE_WORD: Record<TubeChange, string> = { new: '✓ new', grew: '✓ grew', decayed: 'decayed', same: 'unchanged', dropped: 'dropped' };
const ASC = new Set(['id', 'pair']);

function SortHead<K extends string>({ k, cur, set, children }: { k: K; cur: K; set: (k: K) => void; children: string }) {
  return (
    <th className="label" aria-sort={cur === k ? (ASC.has(k) ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="link-button" onClick={() => set(k)}>
        {children}
        {cur === k ? <span aria-hidden="true"> {ASC.has(k) ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  );
}

export function NetworkTable({
  frame,
  diff,
  palette,
  selection,
  onSelect,
}: {
  frame: Frame;
  diff: FrameDiff | null;
  palette: Map<number, number>;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const [sporeSort, setSporeSort] = useState<SporeSort>('r');
  const [tubeSort, setTubeSort] = useState<TubeSort>('d');
  const active = useMemo(() => new Set(frame.active ?? []), [frame.active]);

  const spores = useMemo(() => {
    const rows = [...Array(64).keys()].map((id) => ({ id, r: frame.reputation?.get(id) ?? null, degree: tubesOf(frame.tubes, id).length, active: active.has(id) }));
    type Row = (typeof rows)[number];
    const by = (f: (x: Row) => number) => (a: Row, b: Row) => f(b) - f(a) || a.id - b.id;
    if (sporeSort === 'r') return rows.sort(by((x) => x.r ?? -1));
    if (sporeSort === 'degree') return rows.sort(by((x) => x.degree));
    return rows;
  }, [frame, active, sporeSort]);

  const tubes = useMemo(() => {
    const flows = new Map((frame.flows ?? []).map(([a, b, amt]) => [pairKey(a, b), amt]));
    const rows: { k: PairKey; a: number; b: number; d: number | null; change: TubeChange | null; flow: string | null }[] = [];
    for (const [k, d] of frame.tubes ?? []) {
      const [a, b] = pairOf(k);
      rows.push({ k, a, b, d, change: diff?.change.get(k) ?? null, flow: flows.get(k) ?? null });
    }
    for (const [k, c] of diff?.change ?? []) {
      if (c !== 'dropped') continue;
      const [a, b] = pairOf(k);
      rows.push({ k, a, b, d: null, change: c, flow: flows.get(k) ?? null });
    }
    const rank: Record<TubeChange, number> = { new: 0, grew: 1, decayed: 2, same: 3, dropped: 4 };
    if (tubeSort === 'd') rows.sort((x, y) => (y.d ?? -1) - (x.d ?? -1) || x.k - y.k);
    else if (tubeSort === 'change') rows.sort((x, y) => (x.change ? rank[x.change] : 9) - (y.change ? rank[y.change] : 9) || (y.d ?? 0) - (x.d ?? 0));
    else rows.sort((x, y) => x.k - y.k);
    return rows;
  }, [frame, diff, tubeSort]);

  const selNode = selection?.kind === 'node' ? selection.id : null;
  const selTube = selection?.kind === 'tube' ? selection.k : null;
  return (
    <div className="network-tables">
      <section aria-labelledby="t-spores">
        <h2 className="heading" id="t-spores">
          Spores <span className="mono-s unavailable">epoch {frame.epoch}</span>
        </h2>
        <table className="net-table">
          <thead>
            <tr>
              <SortHead k="id" cur={sporeSort} set={setSporeSort}>
                Spore
              </SortHead>
              <th className="label">State</th>
              <SortHead k="r" cur={sporeSort} set={setSporeSort}>
                R
              </SortHead>
              <SortHead k="degree" cur={sporeSort} set={setSporeSort}>
                Tubes
              </SortHead>
            </tr>
          </thead>
          <tbody>
            {spores.map((s) => (
              <tr key={s.id} aria-selected={selNode === s.id}>
                <td>
                  <SporeRef id={s.id} palette={palette.get(s.id) ?? null} onClick={() => onSelect({ kind: 'node', id: s.id })} />{' '}
                  <span className="mono-s unavailable">{palettes[palette.get(s.id) ?? 0]?.name}</span>
                </td>
                <td className="body">{s.active ? '● active' : '○ dormant'}</td>
                <td className="mono">{s.r === null ? '—' : formatR(s.r)}</td>
                <td className="mono">{s.degree}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="t-tubes">
        <h2 className="heading" id="t-tubes">
          Tubes <span className="mono-s unavailable">{frame.tubes ? `${frame.tubes.size} at epoch ${frame.epoch}` : 'unknown at this epoch'}</span>
        </h2>
        <table className="net-table">
          <thead>
            <tr>
              <SortHead k="pair" cur={tubeSort} set={setTubeSort}>
                Pair
              </SortHead>
              <SortHead k="d" cur={tubeSort} set={setTubeSort}>
                D
              </SortHead>
              <SortHead k="change" cur={tubeSort} set={setTubeSort}>
                At the close
              </SortHead>
              <th className="label">Flow this epoch</th>
            </tr>
          </thead>
          <tbody>
            {tubes.map((t) => (
              <tr key={t.k} aria-selected={selTube === t.k}>
                <td>
                  <button type="button" className="link-button mono" onClick={() => onSelect({ kind: 'tube', k: t.k })}>
                    #{t.a} ↔ #{t.b}
                  </button>
                </td>
                <td className="mono">{t.d === null ? '—' : formatD(t.d)}</td>
                <td className={`body ${t.change === 'new' || t.change === 'grew' ? 'tone-growth' : ''}`}>{t.change ? CHANGE_WORD[t.change] : '—'}</td>
                <td className="mono value">{t.flow ? formatNear(t.flow) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!tubes.length && <p className="body feed-empty">{frame.tubes ? 'No tubes at this epoch.' : 'This source has no tube set for this epoch.'}</p>}
      </section>
    </div>
  );
}
