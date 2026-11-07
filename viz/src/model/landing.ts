// What the landing page's story shows as evidence, read from the same recorded run as its
// plate. Nothing here is written by hand: if the run doesn't have a thing, it's null and
// the page says less. Loaded with the story, not the page.
import { readDecision, tubeBeatCheaper, type Decision } from './decisions';
import { buildLoop, frameOf, heroOf, loopLines, type HeroFrame, type LoopRun } from './loop';

export interface HireExample {
  consumer: number;
  winner: number;
  service: string | null;
  /** The tube beat a lower price, in this decision. */
  beatCheaper: boolean;
  tx: string | null;
  quotes: { provider: number; price: string; d: string; score: string; won: boolean; tube: boolean }[];
}

export interface LandingFacts {
  run: string;
  hero: number;
  /** The spore as it stood before the sale: the plate's specimen. */
  specimen: HeroFrame;
  /** Its strongest tube in that frame. */
  strongest: { id: number; d: number } | null;
  wake: { balance: string; allowance: string; epoch: number } | null;
  hire: HireExample | null;
  growth: { partner: number; before: number; after: number; epoch: number; tx: string | null } | null;
  /** One tube, close by close. */
  tubeHistory: { partner: number; points: { epoch: number; d: number }[] } | null;
  rep: { from: string; to: string; allowanceFrom: string; allowanceTo: string } | null;
  /** The picture at the run's start, middle and end. */
  arts: HeroFrame[];
  sale: {
    price: string;
    sellerGot: string | null;
    royaltyGot: string | null;
    royaltyBps: number;
    buyer: string;
    seller: string;
    buyTx: string | null;
    refusedKey: { err: string; tx: string | null } | null;
    refusedOwner: { err: string; tx: string | null } | null;
    intact: boolean;
  } | null;
  checks: { passed: number; total: number } | null;
  /** The log's own line on replaying every hire. */
  replay: string | null;
}

/** A decision worth showing: history beating price if the run has one, else the most quotes with a tube among them. */
export function hireExample(decisions: Decision[]): HireExample | null {
  const contested = decisions.filter((d) => d.candidates.length > 1 && d.winner !== null && d.outcome === 'settled');
  const best =
    contested.find(tubeBeatCheaper) ??
    contested.filter((d) => d.candidates.some((c) => BigInt(c.d) > 0n)).sort((a, b) => b.candidates.length - a.candidates.length)[0] ??
    contested.sort((a, b) => b.candidates.length - a.candidates.length)[0];
  if (!best) return null;
  return {
    consumer: best.consumer,
    winner: best.winner!,
    service: best.service ?? null,
    beatCheaper: tubeBeatCheaper(best),
    tx: best.tx.accept ?? null,
    quotes: best.candidates.map((c) => ({ provider: c.provider, price: c.price, d: c.d, score: c.score, won: c.provider === best.winner, tube: BigInt(c.d) > 0n })),
  };
}

/** Its picture early, midway and at its fullest, each different in what it's drawn from. */
function threeFrames(frames: HeroFrame[], last: HeroFrame): HeroFrame[] {
  const upTo = frames.slice(0, frames.indexOf(last) + 1);
  const picks = [upTo[0], upTo[Math.floor(upTo.length / 2)], last];
  return picks.filter((f, i) => picks.findIndex((x) => x.epoch === f.epoch) === i);
}

export function landingFacts(r: LoopRun): LandingFacts | null {
  const decisions = r.decisions.map(readDecision).filter((d): d is Decision => typeof d !== 'string');
  const hero = heroOf(r, decisions);
  if (hero === null) return null;
  const lines = loopLines(r);
  const end = buildLoop(lines);
  const frames = r.snapshots.map((s) => frameOf(s, hero)).filter((f): f is HeroFrame => !!f).sort((a, b) => a.epoch - b.epoch);
  if (!frames.length) return null;
  const saleEpoch = typeof r.report?.sale?.epoch === 'number' ? r.report.sale.epoch : null;
  const owned = saleEpoch === null ? frames : frames.filter((f) => f.epoch <= saleEpoch);
  const specimen = [...(owned.length ? owned : frames)].reverse().find((f) => f.tubes.length > 0) ?? frames[frames.length - 1];
  const strongest = specimen.tubes.reduce<{ id: number; d: number } | null>((best, [id, d]) => (!best || Number(d) > best.d ? { id, d: Number(d) } : best), null);
  const growth = end.growth;
  const partner = growth?.partner ?? strongest?.id ?? null;
  const sale = end.sale;
  const start = end.start;
  const refused = (step: typeof sale.oldKey) => (step?.state === 'failed' && step.err ? { err: step.err, tx: step.tx ?? null } : null);
  return {
    run: r.run.run ?? '',
    hero,
    specimen,
    strongest,
    wake: start ? { balance: start.balance, allowance: start.allowance, epoch: start.epoch } : null,
    hire: hireExample(decisions),
    growth: growth ? { ...growth, tx: end.txs.close ?? null } : null,
    tubeHistory: partner === null ? null : { partner, points: frames.map((f) => ({ epoch: f.epoch, d: Number(f.tubes.find(([n]) => n === partner)?.[1] ?? 0) })) },
    rep: end.rep,
    arts: threeFrames(frames, specimen),
    sale:
      sale.start && sale.sold
        ? {
            price: sale.start.price,
            sellerGot: sale.payouts.seller?.amount ?? null,
            royaltyGot: sale.payouts.royalty?.amount ?? null,
            royaltyBps: sale.start.royalty_bps,
            buyer: sale.start.buyer,
            seller: sale.start.seller,
            buyTx: sale.buyTx,
            refusedKey: refused(sale.oldKey),
            refusedOwner: refused(sale.oldOwner),
            intact: sale.intact,
          }
        : null,
    checks: end.checks ? { passed: end.checks.filter((c) => c.ok).length, total: end.checks.length } : null,
    replay: r.report?.replay ?? null,
  };
}
