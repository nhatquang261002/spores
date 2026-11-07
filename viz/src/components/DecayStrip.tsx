// The decay strip (Design §6.H, Rogue): the spore's art at N, N+1 and N+2 while
// its agent is quiet, with the chain's D values under each. A plate appears
// only after the close that made it; empty places say what would fill them.
import { EXPLORER } from '../chain/rpc';
import type { DecayPlate } from '../model/scene';
import { repText } from '../model/scene';
import { shortHash } from '../ui/format';
import { SporeArtwork } from './SporeArtwork';

const MARKS = ['N', 'N+1', 'N+2'];

function Plate({ p, sporeId, maxD }: { p: DecayPlate; sporeId: number; maxD: number }) {
  return (
    <li className="plate">
      <SporeArtwork organism={{ id: sporeId, seed: p.art.seed, age: p.art.age, tubes: p.art.edges.map(([n, d]) => [n, String(d)]) }} variant="card" priority={0} />
      <div className="plate-head">
        <span className="heading">{p.mark}</span>
        <span className="mono">epoch {p.epoch}</span>
        <span className="mono plate-r">R {repText(p.reputation)}</span>
      </div>
      <ul className="plate-tubes">
        {p.tubes.map(([n, d]) => (
          <li key={n}>
            <span className="mono-s">#{n}</span>
            <span className="plate-bar" style={{ width: `${Math.sqrt(Number(d) / maxD) * 100}%` }} aria-hidden="true" />
            <span className="mono-s">{Number(d).toLocaleString('en-US')}</span>
          </li>
        ))}
        {p.removed.map((n) => (
          <li key={n} className="is-removed">
            <span className="mono-s">#{n}</span>
            <span className="body">tube removed at this close</span>
          </li>
        ))}
      </ul>
      {p.close?.tx && (
        <a className="mono-s" href={`${EXPLORER}/${p.close.tx}`} target="_blank" rel="noreferrer" aria-label={`close of epoch ${p.close.epoch}, tx ${p.close.tx}, opens the explorer`}>
          close {shortHash(p.close.tx)} ↗
        </a>
      )}
    </li>
  );
}

export function DecayStrip({ plates, sporeId, active, decayBps }: { plates: DecayPlate[]; sporeId: number | null; active: boolean; decayBps: number | null }) {
  if (sporeId === null || (!plates.length && !active)) return null;
  const maxD = Math.max(1, ...plates.flatMap((p) => p.tubes.map(([, d]) => Number(d))));
  return (
    <section className="decay" aria-label="Decay while the agent is quiet">
      <h2 className="title">Then it goes quiet</h2>
      <p className="body-l">Tubes live on settled work. With none, each close takes {decayBps !== null ? `${decayBps / 100}%` : 'a share'} of every D, and a tube under the minimum is removed. The art is drawn from the tubes, so it changes with them.</p>
      <ol className="plates">
        {plates.map((p) => (
          <Plate key={p.mark} p={p} sporeId={sporeId} maxD={maxD} />
        ))}
        {MARKS.slice(plates.length).map((m) => (
          <li key={m} className="plate is-waiting">
            <span className="heading">{m}</span>
            <span className="body">Appears when the chain closes this epoch.</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
