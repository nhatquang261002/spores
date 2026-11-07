// The landing page below its first screen (Design §6.A, §13 item 23): what a spore is, what
// we do, how it works and how to check it. The words are fixed; every
// figure beside them is read from the recording the plate plays (model/landing.ts), or is a
// result in docs/results.md under its own mark. Lazy: the first screen doesn't wait for it.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import { landingFacts, type HireExample, type LandingFacts } from '../model/landing';
import { artReach, slotDir, type Pt } from '../model/network';
import { repText } from '../model/scene';
import type { Source } from '../model/types';
import { linkTo, sourceQuery } from '../sources/source';
import { useLoopRun, useStorySource } from '../state/loop';
import { useApp } from '../state/source';
import { formatNear, tubesText } from '../ui/format';
import { SourceBadge } from '../ui/status';
import { hex, paletteOf } from '../ui/tokens';
import { HandArrow } from './HandArrow';
import { SporeArtwork } from './SporeArtwork';
import './activity.css';

/** True once `el` has been on screen. Without an observer, at once. */
function useSeen(el: HTMLElement | null, margin = '-15% 0px'): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver !== 'function');
  useEffect(() => {
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen, margin]);
  return seen;
}

const txLink = (tx: string | null | undefined, word: string) =>
  tx ? <a className="body ov-tx" href={`${EXPLORER}/${tx}`} target="_blank" rel="noreferrer">{word} ↗</a> : null;

function Kicker({ id, eyebrow, line, children }: { id: string; eyebrow: string; line: string; children?: ReactNode }) {
  return (
    <header className="landing-head">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="ov-section-line">{line}</h2>
      {children}
    </header>
  );
}

// The plate's coordinates: the art's square inside a 1000 × 560 sheet.
const SHEET = { w: 1000, h: 560, x: 290, y: 100, side: 420 };
const onArt = (x: number, y: number): Pt => ({ x: SHEET.x + (x * SHEET.side) / 512, y: SHEET.y + (y * SHEET.side) / 512 });

/** A real spore with a pen's labels on it. The nucleus, partner and ring slot are where the renderer puts them (renderer/src/sim.rs); the web is the simulation's own, so its arrow only lands in it. */
function Specimen({ facts }: { facts: LandingFacts }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const seen = useSeen(el, '-25% 0px');
  const f = facts.specimen;
  const best = facts.strongest;
  const organism = useMemo(() => ({ id: f.art.id, seed: f.art.seed, age: f.art.age, tubes: f.tubes }), [f]);
  const nucleus = onArt(256, 256);
  const partner = best ? (() => {
    const u = slotDir(best.id);
    const r = artReach(best.d, f.tubes.length);
    return onArt(256 + u.x * r, 256 + u.y * r);
  })() : null;
  const web = onArt(256 + 92, 256 + 68);
  // An empty slot on the far side from its partners: the ring's dots are drawn only where there's no tube.
  const taken = new Set(f.tubes.map(([n]) => n));
  const empty = [48, 44, 52, 40, 56, 36].find((id) => !taken.has(id)) ?? 48;
  const slot = (() => {
    const u = slotDir(empty);
    return onArt(256 + u.x * 168, 256 + u.y * 168);
  })();
  return (
    <figure className="sp-plate" ref={setEl}>
      <div className="sp-art">
        <SporeArtwork organism={organism} variant="full" priority={3} />
      </div>
      <figcaption className="sp-caption mono-s">Spore #{facts.hero} at epoch {f.epoch} · {tubesText(f.tubes.length)} · age {f.art.age}</figcaption>
      <p className="sp-label is-tl"><span className="heading">The nucleus.</span> <span className="body">Spore #{facts.hero} itself, at the centre of its own picture.</span></p>
      <p className="sp-label is-bl"><span className="heading">The ring.</span> <span className="body">64 slots, one for each spore in the collection, always in the same order.</span></p>
      {best && <p className="sp-label is-tr"><span className="heading">A partner.</span> <span className="body">#{best.id}, its strongest tube, at its own slot. The stronger the tube, the nearer the centre it’s drawn.</span></p>}
      <p className="sp-label is-br"><span className="heading">The web.</span> <span className="body">Nobody drew it. A slime-mold simulation grows it from the spore’s seed, age and tubes, so it changes as the spore trades.</span></p>
      {seen && (
        <svg className="sp-pen" viewBox={`0 0 ${SHEET.w} ${SHEET.h}`} aria-hidden="true">
          <HandArrow from={{ x: 252, y: 86 }} to={{ x: nucleus.x - 14, y: nucleus.y - 10 }} bow={-26} seed="nucleus" />
          <HandArrow from={{ x: 252, y: 450 }} to={{ x: slot.x - 6, y: slot.y + 3 }} bow={22} seed="ring" />
          {partner && <HandArrow from={{ x: 748, y: 130 }} to={{ x: partner.x + 9, y: partner.y + 1 }} bow={-34} seed="partner" />}
          <HandArrow from={{ x: 748, y: 450 }} to={{ x: web.x + 6, y: web.y + 4 }} bow={-20} seed="web" />
        </svg>
      )}
    </figure>
  );
}

function WhatItIs({ facts, source }: { facts: LandingFacts | null; source: Source | null }) {
  return (
    <section className="landing-section" id="what" aria-labelledby="what-title">
      <Kicker id="what-title" eyebrow="What it is" line="A Spore is an NFT that’s alive, and it works for whoever holds it.">
        <p className="body-l landing-lede">Spores is a collection of 64 slime molds on NEAR testnet, modelled on how <em>Physarum polycephalum</em> thickens the tubes that carry flow and lets the others die back. Here the flow is money.</p>
      </Kicker>
      {facts && <Specimen facts={facts} />}
      {facts && source && <p className="landing-source"><SourceBadge source={source} staleSince={null} compact /> <span className="label">A real spore. Its picture is redrawn in your browser.</span></p>}
      <ul className="landing-three" role="list">
        <li><h3 className="title">It’s a picture</h3><p className="body">The image is the spore’s real trading network, drawn from chain state. It grows, shrinks and changes as the spore lives.</p></li>
        <li><h3 className="title">It’s an account</h3><p className="body">Each spore holds its own money, in the contract’s ledger under its id. Its agent earns by doing work for other spores and pays others for theirs.</p></li>
        <li><h3 className="title">It’s a key</h3><p className="body">Whoever holds the NFT controls the agent and owns the money. Sell it, and all of that goes with it, while the old agent’s key stops working.</p></li>
      </ul>
    </section>
  );
}

const PROBLEMS: [string, string][] = [
  ['An agent that holds money needs an owner, and handing it over shouldn’t mean handing over keys.', 'The NFT is the account. Transfer it and the money, history and control move together, in one call.'],
  ['Agents that pick by price alone ignore track record, and track records usually sit where nobody can check them.', 'Every settled payment grows a tube on chain. Agents weigh quotes by those tubes, and anyone can replay the numbers.'],
  ['One bad prompt shouldn’t be able to drain an agent.', 'Limits live in the contract, not in agent code: budget, per-payment cap, allowlist, pause. What it may spend grows only as it earns trust.'],
  ['Any reputation signal invites fake activity.', 'Trading with yourself costs fees and saturates quickly. In simulation, the attacker lost money in 270 of 270 cases.'],
  ['Generative NFT art is usually random, then frozen, so it records nothing.', 'Each picture is drawn from the spore’s own history, and anyone can redraw it and compare its hash.'],
];

function WhatWeDo() {
  return (
    <section className="landing-section" id="why" aria-labelledby="why-title">
      <Kicker id="why-title" eyebrow="What we do" line="We give an agent an owner, a track record and a limit it can’t talk its way past." />
      <ul className="landing-ledger" role="list">
        {PROBLEMS.map(([problem, answer]) => (
          <li key={problem}>
            <p className="body landing-problem">{problem}</p>
            <p className="body-l landing-answer">{answer}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuoteBars({ hire }: { hire: HireExample }) {
  const top = hire.quotes.reduce((m, q) => (BigInt(q.price) > m ? BigInt(q.price) : m), 1n);
  const share = (v: string) => `${Number((BigInt(v) * 1000n) / top) / 10}%`;
  return (
    <figure className="how-figure">
      <figcaption className="label">Spore #{hire.consumer} picks a provider{hire.service ? ` for a “${hire.service}” job` : ''}. The outline is each quote, the bar its score, and the lowest score wins.{hire.beatCheaper ? ' Here a tube beat a lower price.' : ''}</figcaption>
      <table className="how-quotes">
        <thead className="sr-only"><tr><th>Provider</th><th>Quote and score</th><th>Result</th></tr></thead>
        <tbody>
          {hire.quotes.map((q) => (
            <tr key={q.provider} className={q.won ? 'is-won' : undefined}>
              <th scope="row" className="mono-s">#{q.provider}</th>
              <td>
                <span className="how-bar" style={{ width: share(q.price) }}><span style={{ width: `${(Number(BigInt(q.score) * 1000n / BigInt(q.price)) / 10)}%` }} /></span>
                <span className="mono-s how-bar-words"><span className="money">{formatNear(q.price)}</span> · {q.tube ? 'has a tube' : 'no tube'} · score {formatNear(q.score).replace(' NEAR', '')}</span>
              </td>
              <td className="label">{q.won ? <span className="tone-growth"><span aria-hidden="true">✓ </span>hired</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {txLink(hire.tx, 'The hire')}
    </figure>
  );
}

/** One tube, close by close: its width is √D, as everywhere else it's drawn. */
function TubeHistory({ facts }: { facts: LandingFacts }) {
  const h = facts.tubeHistory!;
  const W = 560;
  const H = 72;
  const max = Math.max(1, ...h.points.map((p) => p.d));
  const step = W / Math.max(1, h.points.length - 1);
  const half = (d: number) => (d > 0 ? 1 + 15 * Math.sqrt(d / max) : 0.5);
  const edge = (side: 1 | -1) => h.points.map((p, i) => ({ x: i * step, y: H / 2 + side * half(p.d) }));
  // Smooth from close to close: a tube, not a bar chart.
  const upper = edge(-1);
  const lower = edge(1).reverse();
  const smooth = (pts: Pt[], dir: 1 | -1) => pts.slice(1).map((p, i) => `C${(pts[i].x + (dir * step) / 2).toFixed(1)} ${pts[i].y.toFixed(1)} ${(p.x - (dir * step) / 2).toFixed(1)} ${p.y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const body = `M0 ${upper[0].y.toFixed(1)} ${smooth(upper, 1)} L${lower[0].x.toFixed(1)} ${lower[0].y.toFixed(1)} ${smooth(lower, -1)} Z`;
  const peak = h.points.reduce((a, b) => (b.d > a.d ? b : a));
  const last = h.points[h.points.length - 1];
  return (
    <figure className="how-figure">
      <figcaption className="label">Its tube to #{h.partner}, at every close. D is its strength, and it only ever changes at a close.</figcaption>
      <svg className="how-tube" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Tube to #${h.partner}: D ${peak.d.toLocaleString('en-US')} at its peak in epoch ${peak.epoch}, D ${last.d.toLocaleString('en-US')} at epoch ${last.epoch}`}>
        <path d={body} fill={hex(paletteOf(facts.specimen.art.seed).stops[3])} />
      </svg>
      <p className="mono-s how-tube-ends">
        <span>epoch {h.points[0].epoch}: D {h.points[0].d.toLocaleString('en-US')}</span>
        <span>epoch {peak.epoch}: D {peak.d.toLocaleString('en-US')}</span>
        <span>epoch {last.epoch}: D {last.d.toLocaleString('en-US')}</span>
      </p>
      {txLink(facts.growth?.tx, 'The close')}
    </figure>
  );
}

function HowItWorks({ facts, source, missing }: { facts: LandingFacts | null; source: Source | null; missing: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const { reducedMotion } = useApp();
  // The vein grows down the steps as you read them. It's decorative: the steps say it all.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const steps = [...el.querySelectorAll<HTMLElement>('.how-step')];
    if (reducedMotion) {
      el.style.setProperty('--fill', '1');
      steps.forEach((s) => s.classList.add('is-seen'));
      return;
    }
    let raf = 0;
    const read = () => {
      raf = 0;
      const b = el.getBoundingClientRect();
      const reach = window.innerHeight * 0.62;
      el.style.setProperty('--fill', String(Math.min(1, Math.max(0, (reach - b.top) / (b.height || 1)))));
      for (const s of steps) s.classList.toggle('is-seen', s.getBoundingClientRect().top < reach);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const sale = facts?.sale;
  return (
    <section className="landing-section" id="how" aria-labelledby="how-title">
      <Kicker id="how-title" eyebrow="How it works" line="One loop, enforced by one contract.">
        <p className="body-l landing-lede">Everything below happens on chain, in rounds called epochs. The figures beside each step are real, not an illustration.</p>
        {source && !missing && <p className="landing-source"><SourceBadge source={source} staleSince={null} compact /></p>}
        {missing && <p className="body landing-lede">The figures aren’t available right now, so only the words are here.</p>}
      </Kicker>
      <div className="how" ref={box} style={{ '--fill': 0 } as CSSProperties}>
        <svg className="how-vein is-track" viewBox="0 0 24 1000" preserveAspectRatio="none" aria-hidden="true"><path d="M12 0 C7 160 17 330 12 500 C7 670 17 840 12 1000" /></svg>
        <svg className="how-vein is-fill" viewBox="0 0 24 1000" preserveAspectRatio="none" aria-hidden="true"><path d="M12 0 C7 160 17 330 12 500 C7 670 17 840 12 1000" /></svg>
        <ol className="how-steps" role="list">
          <li className="how-step">
            <div className="how-words">
              <h3 className="title">Wake</h3>
              <p className="body-l">An owner activates a spore with a deposit, appoints an agent and sets its limits. The agent’s key can only make the calls the contract allows, and can’t withdraw.</p>
            </div>
            {facts?.wake && <p className="how-figure mono">Spore #{facts.hero} at epoch {facts.wake.epoch}: <span className="money">{formatNear(facts.wake.balance)}</span>, allowed to spend <span className="money">{formatNear(facts.wake.allowance)}</span> an epoch.</p>}
          </li>
          <li className="how-step">
            <div className="how-words">
              <h3 className="title">Hire</h3>
              <p className="body-l">A spore posts a job and others quote. Its agent scores each quote by price and by the tube it already has with that provider, so a good history can beat a lower price.</p>
              <p className="mono how-rule">score = quote ÷ (1 + 4 × D<sub>norm</sub>)</p>
            </div>
            {facts?.hire && <QuoteBars hire={facts.hire} />}
          </li>
          <li className="how-step">
            <div className="how-words">
              <h3 className="title">Settle and grow</h3>
              <p className="body-l">The payment waits in escrow until the work is delivered and settled. When the epoch closes, the tube between them thickens, every tube decays by a quarter, and weak ones are pruned. Rejected work halves the tube instead.</p>
              <p className="mono how-rule">D′ = D − 25% of D + gain × q ÷ (q + K)</p>
            </div>
            {facts?.tubeHistory && <TubeHistory facts={facts} />}
          </li>
          <li className="how-step">
            <div className="how-words">
              <h3 className="title">Earn trust</h3>
              <p className="body-l">Its tubes add up to a reputation, and reputation sets what the contract lets its agent spend. A neglected spore loses it as its tubes fade.</p>
              <p className="mono how-rule">may spend = min(owner’s budget, base + gain × R)</p>
            </div>
            {facts?.rep && <p className="how-figure mono">After one close: R {repText(facts.rep.from)} → {repText(facts.rep.to)}, and it may spend <span className="money">{formatNear(facts.rep.allowanceFrom)}</span> → <span className="money">{formatNear(facts.rep.allowanceTo)}</span> an epoch.</p>}
          </li>
          <li className="how-step">
            <div className="how-words">
              <h3 className="title">Redraw</h3>
              <p className="body-l">After each close the picture is redrawn by deterministic code from the spore’s seed, age and tubes, and its hash is committed on chain. Anyone can redraw it and compare.</p>
            </div>
            {facts && facts.arts.length > 1 && (
              <ul className="how-arts" role="list">
                {facts.arts.map((f) => (
                  <li key={f.epoch}>
                    <SporeArtwork organism={{ id: f.art.id, seed: f.art.seed, age: f.art.age, tubes: f.tubes }} variant="card" priority={4} />
                    <span className="mono-s">epoch {f.epoch} · {tubesText(f.tubes.length)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li className="how-step">
            <div className="how-words">
              <h3 className="title">Change hands</h3>
              <p className="body-l">The contract’s market moves the NFT, pays the seller and pays a royalty, in one call. The old agent’s key stops working, and the spore arrives paused with a budget of zero. Its balance, tubes and age stay with it, and the new owner appoints their own agent.</p>
            </div>
            {sale && (
              <div className="how-figure">
                <p className="mono">
                  Sold for <span className="money">{formatNear(sale.price)}</span>
                  {sale.sellerGot && <>: <span className="money">{formatNear(sale.sellerGot)}</span> to the seller</>}
                  {sale.royaltyGot && <>, <span className="money">{formatNear(sale.royaltyGot)}</span> royalty ({sale.royaltyBps / 100}%)</>}.
                </p>
                {sale.refusedKey && <p className="body">The old agent tried again. The contract said: <span className="mono tone-warn">{sale.refusedKey.err}</span></p>}
                {sale.refusedOwner && <p className="body">The old owner tried too: <span className="mono tone-warn">{sale.refusedOwner.err}</span></p>}
                {txLink(sale.buyTx, 'The sale')}
              </div>
            )}
          </li>
        </ol>
      </div>
    </section>
  );
}

function Proof({ q, facts }: { q: string; facts: LandingFacts | null }) {
  return (
    <section className="landing-section" id="proof" aria-labelledby="proof-title">
      <Kicker id="proof-title" eyebrow="Proof" line="Don’t take our word for it. Check it, or try to break it." />
      <ul className="landing-proof" role="list">
        <li>
          <h3 className="title">Recompute it</h3>
          <p className="body">Replay every close from its receipt and compare fingerprints, then redraw a spore and compare the image hash. In your browser, or with the <span className="mono-s">spores-verify</span> CLI.</p>
          <p className="mono-s landing-result">In the recording: all 63 epochs and the spore’s image matched{facts?.checks ? `; ${facts.checks.passed} of ${facts.checks.total} checks passed` : ''}.</p>
          {facts?.replay && <p className="mono-s landing-result">{facts.replay}.</p>}
          <Link className="btn btn-primary" to={linkTo('/verify', q)}>Verify it yourself</Link>
        </li>
        <li>
          <h3 className="title">Try to overspend</h3>
          <p className="body">An owner narrows a spore’s limits and its agent tries to go past them. These are the contract’s own answers:</p>
          <ul className="landing-refusals mono-s" role="list">
            <li><span aria-hidden="true">✕ </span>policy: payment exceeds the per-payment cap</li>
            <li><span aria-hidden="true">✕ </span>policy: epoch budget exceeded</li>
            <li><span aria-hidden="true">✕ </span>policy: payee is not on the external allowlist</li>
          </ul>
          <Link className="btn btn-secondary" to={linkTo('/lab/rogue', q)}>Watch the refusals</Link>
        </li>
        <li>
          <h3 className="title">Try to fake it</h3>
          <p className="body">Run a ring of spores that only pay each other. <span className="label landing-sim">SIMULATION</span> The attacker lost money in 270 of 270 cases. It doesn’t always stay below honest spores, though: on a quiet network the reputation half of the test holds in 168 of 270, because a 3-spore loop of 0.2 NEAR or more can reach the honest median.</p>
          <Link className="btn btn-secondary" to={linkTo('/lab/wash', q)}>See the failures too</Link>
        </li>
      </ul>
    </section>
  );
}

function LandingFooter({ q, source }: { q: string; source: Source | null }) {
  const links: [string, string][] = [['/network', 'Network'], ['/market', 'Marketplace'], ['/activity', 'Activity'], ['/verify', 'Verify'], ['/lab', 'Demo Lab']];
  return (
    <footer className="landing-end">
      <div>
        <p className="ov-section-line">Go and look at the living ones.</p>
        <p className="landing-end-actions">
          <Link className="btn btn-primary" to={linkTo('/network', q)}>Explore the network</Link>
          <Link className="btn btn-secondary" to={linkTo('/market', q)}>Browse the spores</Link>
        </p>
      </div>
      <nav aria-label="The app" className="landing-end-nav">
        {links.map(([to, word]) => <Link key={to} className="body" to={linkTo(to, q)}>{word}</Link>)}
        {source?.kind === 'live' && <a className="body" href={`${EXPLORER.replace(/\/txns$/, '/address')}/${source.router}`} target="_blank" rel="noreferrer">The contract ↗</a>}
      </nav>
    </footer>
  );
}

export default function LandingStory({ now }: { now: ReactNode }) {
  const { source } = useApp();
  const found = useStorySource(source);
  const data = useLoopRun(found.story);
  const facts = useMemo(() => (data.run ? landingFacts(data.run) : null), [data.run]);
  const q = source ? sourceQuery(source) : '';
  const missing = !!data.error || !!found.error || (found.done && !found.story);

  // A link to a section lands on it, though it wasn't here when the page first scrolled.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <>
      <WhatItIs facts={facts} source={found.story} />
      <WhatWeDo />
      <HowItWorks facts={facts} source={found.story} missing={missing} />
      <Proof q={q} facts={facts} />
      {now}
      <LandingFooter q={q} source={source} />
    </>
  );
}
