// What makes a stage readable, shared by the landing plate and the Demo Lab: spores you
// can point at, a legend read from the code that draws the stage, and the sheet that names
// the spore beside it. One list, one alignment, a definition on every term.
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { PlateSheet } from '../model/plate';
import { repText } from '../model/scene';
import { linkTo } from '../sources/source';
import { formatNear, tubesText } from '../ui/format';
import { hex, paletteOf } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';
import type { PeerSpot, StageSpots } from './SaleStage';

const dWords = (d: string) => Number(d).toLocaleString('en-US');

/** The spores on the stage, as things you can point at: what each one is, and a way to its page. */
export function useSpots(q: string, reducedHero: number | null): StageSpots {
  return useMemo(() => ({
    hero: (id, size) => (
      <span className="stage-spot-at" style={{ left: '50%', top: '50%' }}>
        <Tooltip focusable={false} content={<>This is <strong>Spore #{id}</strong>: its art, drawn from its own tubes. Open its page.</>}>
          <Link className="stage-spot is-hero" style={{ width: size, height: size }} to={linkTo(`/spore/${id}`, q)} aria-label={`Spore #${id}, the spore in the middle. Open its page`} />
        </Tooltip>
      </span>
    ),
    peer: (p: PeerSpot) => (
      <>
        <span className="stage-spot-at" style={p.at}>
          <Tooltip
            focusable={false}
            // It opens away from the dish's middle, so it doesn't cover what it's about.
            align={p.right ? 'start' : 'end'}
            content={
              <>
                <strong>Spore #{p.id}</strong>
                {p.role && <><br />{p.role}.</>}
                {p.quote && <><br />Quoted {formatNear(p.quote)} for this job{p.state === 'won' ? ' and was hired' : p.state === 'lost' ? ' and lost' : ''}.</>}
                {p.removed ? <><br />Its tube to #{reducedHero} fell under the minimum and was removed.</> : p.d ? <><br />Tube to #{reducedHero}: D {dWords(p.d)}. D is its strength.</> : !p.quote && !p.role && <><br />No tube yet.</>}
                <br />Open its page.
              </>
            }
          >
            <Link className={`stage-spot is-${p.state}`} style={{ width: p.size, height: p.size }} to={linkTo(`/spore/${p.id}`, q)} aria-label={`Spore #${p.id}${p.d ? `, tube D ${dWords(p.d)}` : ''}. Open its page`} />
          </Tooltip>
        </span>
        <span className={`stage-note ${p.right ? 'is-right' : 'is-left'}${p.state === 'lost' || p.removed ? ' is-gone' : ''}${p.state === 'won' || p.state === 'grown' ? ' is-on' : ''}`} style={p.label}>
          <span className="mono-s">#{p.id}</span>
          {p.quote && <span className={`mono-s ${p.state === 'won' ? 'money' : 'stage-d'}`}>{formatNear(p.quote)}</span>}
          {p.removed && <span className="mono-s stage-d">removed</span>}
        </span>
      </>
    ),
  }), [q, reducedHero]);
}

export type LegendMark = 'hero' | 'peer' | 'tube' | 'agent' | 'wall' | 'rim' | 'attempt' | 'refused';

/** What's drawn on a stage. Each scene names the marks its stage draws. */
export function StageLegend({ seed, marks }: { seed: string | null; marks: LegendMark[] }) {
  const tube = seed ? hex(paletteOf(seed).stops[3]) : 'currentColor';
  const all: Record<LegendMark, { word: string; tip: string; mark: ReactNode }> = {
    hero: { word: 'this spore', tip: 'The spore in the middle. Its picture is drawn from its tubes.', mark: <circle cx="8" cy="8" r="4" fill="var(--text)" /> },
    peer: { word: 'other spores', tip: 'Spores it trades with, or that quoted for its job. Each stands at its own place on a ring of 64.', mark: <circle cx="8" cy="8" r="4" fill="none" stroke="var(--text-2)" strokeWidth="1.5" /> },
    tube: { word: 'tube', tip: 'Grows from settled payments, at an epoch’s close, and decays without them. Thicker means stronger.', mark: <path d="M1 11 C5 4 10 12 15 5" fill="none" stroke={tube} strokeWidth="3" strokeLinecap="round" /> },
    agent: { word: 'its agent', tip: 'The agent’s key, held for the spore’s owner. It’s cut when the spore is sold.', mark: <path d="M1 12 L15 4" fill="none" stroke="var(--agent)" strokeWidth="2.5" strokeLinecap="round" /> },
    wall: { word: 'contract’s wall', tip: 'Limits the contract enforces, not the agent. A ✕ marks a refusal.', mark: <circle cx="8" cy="8" r="6" fill="none" stroke="var(--slime)" strokeWidth="1.5" /> },
    rim: { word: 'may spend', tip: 'The dish’s rim: what it may spend each epoch. A full circle is the budget its owner set.', mark: <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="var(--value)" strokeWidth="2.5" strokeLinecap="round" /> },
    attempt: { word: 'attempt', tip: 'The agent reaching out with money, a real transaction. The bead is the amount.', mark: <><path d="M1 13 L11 5" fill="none" stroke="var(--agent)" strokeWidth="2.5" strokeLinecap="round" /><circle cx="12" cy="4" r="2.5" fill="var(--value)" /></> },
    refused: { word: 'refused', tip: 'The contract said no, on the tx’s final outcome.', mark: <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" /> },
  };
  return (
    <ul className="stage-legend" aria-label="What’s on the stage">
      {marks.map((key) => (
        <li key={key}>
          <Tooltip content={all[key].tip}>
            <span className="stage-legend-item label">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{all[key].mark}</svg>
              {all[key].word}
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

export interface SheetRow {
  term: string;
  tip: string;
  value: ReactNode;
  money?: boolean;
  /** A change beside the value, or a mark such as `✓ kept`. */
  side?: ReactNode;
  spent?: boolean;
}

/** A spore's label: its name, what state it's in if the scene knows, and its figures in one column. */
export function SpecimenSheet({ spore, to, status, rows, label }: { spore: number; to?: string; status?: PlateSheet['status']; rows: SheetRow[]; label: string }) {
  return (
    <section className="sheet" aria-label={label}>
      <header className="sheet-head">
        <h2 className="display-s">{to ? <Link to={to} className="sheet-name">Spore #{spore}</Link> : <>Spore #{spore}</>}</h2>
        {status && <span className={`sheet-status label tone-${status.tone === 'money' ? 'value' : status.tone}`} key={status.word}><span aria-hidden="true">{status.glyph} </span>{status.word}</span>}
        {status && <p className="body sheet-why">{status.why}</p>}
      </header>
      <dl className="sheet-rows">
        {rows.map((r) => (
          <div key={r.term} className="sheet-row">
            <dt className="label"><Tooltip content={r.tip}><span className="sheet-term">{r.term}</span></Tooltip></dt>
            <dd className="mono-s">
              <span className={r.money ? 'money' : undefined}>{r.value}</span>
              {r.side && <span className={r.spent ? 'is-spent' : 'money'}>{r.side}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Which spore this is, what state it's in, who holds it, what it has: read from the recording. */
export function SporeSheet({ sheet, to }: { sheet: PlateSheet | null; to?: string }) {
  if (!sheet) return <div className="sheet" aria-hidden="true" />;
  const rows: SheetRow[] = [
    { term: 'Owner', tip: 'Whoever holds the NFT controls the agent and owns its money.', value: sheet.owner, side: sheet.ownerDelta, spent: true },
    ...(sheet.previousOwner ? [{ term: 'Previous owner', tip: 'Paid at the sale, then refused by the contract.', value: sheet.previousOwner, side: sheet.previousDelta }] : []),
    ...(sheet.royalty ? [{ term: 'Royalty', tip: `This account, the collection’s creator, gets ${sheet.royalty.bps / 100}% of every sale.`, value: sheet.royalty.account, side: sheet.royalty.got }] : []),
    { term: 'Agent', tip: 'The account running the spore, on a key that can only make the calls the contract allows.', value: sheet.agent ?? 'none until the owner appoints one' },
    { term: 'Balance', tip: 'Its own money, in testnet NEAR, held by the contract under its id. Testnet NEAR has no value.', value: formatNear(sheet.balance), money: true },
    { term: 'Reputation', tip: `R, added up from its tubes.${sheet.allowance ? ` It lets the agent spend ${formatNear(sheet.allowance)} an epoch now.` : ''}`, value: repText(sheet.reputation) },
    { term: 'Tubes', tip: 'Live links to other spores, grown by settled payments.', value: tubesText(sheet.tubes).replace(/ tubes?$/, '') },
    { term: 'Age', tip: 'Epochs since it was activated. It stays with the spore through a sale.', value: `${sheet.age} epochs` },
  ];
  return <SpecimenSheet spore={sheet.spore} to={to} status={sheet.status} rows={rows} label={`Spore #${sheet.spore}, as of this moment in the recording`} />;
}
