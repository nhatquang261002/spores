// Spore detail `/spore/:id` (Design §6.D): sticky art on the left; identity,
// owner actions, R (the one primary figure), four inline figures,
// connections, agent and policy, market, activity and Technical on the right.
// LIVE reads spore_summary + nft_token (and the bulk gallery read, shared with
// the Marketplace, for partner thumbnails); runs read their last snapshot.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { AgentStatus, AllowanceDisplay, allowanceFormula, BalanceDisplay } from '../components/economy';
import { CompactFeed } from '../components/EventFeed';
import { ConductivityIndicator, SporeRef } from '../components/indicators';
import { OwnerActions } from '../components/ownerActions';
import { artKey, SporeArtwork } from '../components/SporeArtwork';
import { StateMarker } from '../components/StateMarker';
import { SporeVerification } from '../components/VerificationResult';
import '../components/detail.css';
import '../components/gallery.css';
import { imageBadge, type RenderedImage } from '../model/gallery';
import { shareOfR, type SporeView } from '../model/spore';
import type { Organism } from '../model/types';
import { linkTo, sourceQuery } from '../sources/source';
import { useActivity } from '../state/activity';
import { useGallery } from '../state/gallery';
import { useApp } from '../state/source';
import { useConfig, useSpore } from '../state/spore';
import { useWallet } from '../state/wallet';
import { formatClock, formatNear, formatR, shortAccount, shortHash } from '../ui/format';
import { useCloseSwell } from '../ui/motion';
import { EmptyState, ErrorState, LoadingBar, Unavailable } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { hex, paletteOf } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';
import { PageHeader } from './Pages';

/** Where the user came from (Design §5.4): Link state `{ from: { label, to } }`, else Marketplace. */
function Breadcrumb({ id, q }: { id: number; q: string }) {
  const from = (useLocation().state as { from?: { label: string; to: string } } | null)?.from ?? { label: 'Marketplace', to: `/market${q}` };
  return (
    <nav className="breadcrumb body" aria-label="Breadcrumb">
      <Link to={from.to}>{from.label}</Link> <span aria-hidden="true">/</span> <span aria-current="page">Spore #{id}</span>
    </nav>
  );
}

/** `render v1 · image 7e3a…c901 ✓ matches commit at epoch 17` (Design §6.D). The same real check as the gallery badge. */
function ArtCaption({ spore, rendered }: { spore: SporeView; rendered: RenderedImage | null }) {
  const badge = imageBadge(spore.image, rendered);
  const c = spore.image.commit;
  const head = rendered ? `render v${rendered.rendererVersion} · image ${shortHash(rendered.imageHash)}` : 'rendering…';
  const tail: ReactNode = (() => {
    switch (badge) {
      case 'match':
        return (
          <span className="evidence-ok">
            <span aria-hidden="true">✓</span> matches commit at epoch {c!.epoch}
          </span>
        );
      case 'mismatch':
        return (
          <span className="evidence-bad">
            <span aria-hidden="true">✕</span> differs from the epoch {c!.epoch} commit {shortHash(c!.imageHash)}
          </span>
        );
      case 'none':
        return 'no image committed';
      case 'older':
        return `◷ the commit is for epoch ${c!.epoch}; the state is epoch ${spore.image.stateEpoch}`;
      case 'other-renderer':
        return `! committed with renderer v${c!.rendererVersion}; not comparable`;
      case 'checking':
        return `checking against the epoch ${c!.epoch} commit…`;
    }
  })();
  const tip =
    badge === 'match' || badge === 'mismatch'
      ? 'Your browser rendered this state and compared its hash with the commit for the same epoch and stored state hash.'
      : 'Rendered in your browser from the spore’s seed, age and tubes.';
  return (
    <p className="mono-s art-caption" role="status">
      <Tooltip content={tip}>
        <span>
          {head} · {tail}
        </span>
      </Tooltip>
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section" aria-label={title}>
      <h2 className="heading">{title}</h2>
      {children}
    </section>
  );
}

function Hash({ h }: { h: string }) {
  return (
    <Tooltip content={<span className="mono">{h}</span>}>
      <span>{shortHash(h)}</span>
    </Tooltip>
  );
}

/** This spore's rows from the run log (Design §6.D, `EventFeed` compact). LIVE has no per-spore history without an indexer (§1.7). */
function useSporeRows(id: number) {
  const { source } = useApp();
  const logs = source && (source.kind === 'run' || source.kind === 'recorded') ? source : null;
  const state = useActivity(logs, null);
  const rows = useMemo(() => (state.data?.rows ?? []).filter((r) => r.kind !== 'unreadable' && r.spores.includes(id)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)), [state.data, id]);
  return { logs, state, rows };
}
type SporeRows = ReturnType<typeof useSporeRows>;

function SporeActivity({ id, q, log }: { id: number; q: string; log: SporeRows }) {
  const { logs, state, rows } = log;
  const all = linkTo('/activity', q, { spore: id, view: 'log' });
  if (!logs) {
    return (
      <p className="body">
        <Unavailable reason="Not on chain: written by the agents’ log." /> Jobs and decisions are in the agents’ log, not on chain.{' '}
        <Link to={all}>Activity</Link> lists what this source has; <Link to={networkLink(q, String(id))}>its tubes are in the Network</Link>.
      </p>
    );
  }
  if (state.error) return <ErrorState error={state.error} what="the agents’ log" onRetry={state.retry} />;
  if (!state.data) return <LoadingBar ch={12} label="Reading the agents’ log" />;
  if (!rows.length) return <p className="body">These logs have no rows for Spore #{id}.</p>;
  return (
    <>
      {/* Routine notes (margin changes, process lines) stay in the full feed. */}
      <CompactFeed rows={rows.filter((r) => !r.note).slice(0, 6)} more={all} />
      <p className="body">
        <Link to={all}>All {rows.length} rows for Spore #{id} →</Link>
      </p>
    </>
  );
}

function LastSale({ id, q, log }: { id: number; q: string; log: SporeRows }) {
  const { logs, state, rows } = log;
  if (!logs) return <Unavailable reason="The last sale is in the chain’s transaction logs, which this app doesn’t search. A recording lists it: see Activity." />;
  if (!state.data) return <Unavailable reason="Reading the agents’ log." />;
  const sale = rows.find((r) => r.kind === 'market' && r.word === 'Sold');
  if (!sale) return <Unavailable reason="These logs have no sale of this spore; an earlier sale would not be in them." />;
  return <Link to={linkTo('/activity', q, { spore: id, kind: 'market' })}>{sale.at !== null ? formatClock(sale.at) : 'in this run'}</Link>;
}

const networkLink = (q: string, sel: string) => `/network${q ? `${q}&` : '?'}sel=${sel}`;

function Connections({ spore, partners, dMax, dMin, q }: { spore: SporeView; partners: Map<number, Organism> | null; dMax: number; dMin: number; q: string }) {
  const o = spore.organism;
  if (o.tubes.length === 0) return <p className="body unavailable">No tubes yet. A tube grows when a job between two spores settles, at the next epoch close.</p>;
  const rows = [...o.tubes].sort((a, b) => Number(b[1]) - Number(a[1]) || a[0] - b[0]);
  return (
    <ul className="connections">
      {rows.map(([n, d]) => {
        const p = partners?.get(n) ?? null;
        return (
          <li key={n}>
            <span className="conn-thumb">{p ? <SporeArtwork organism={p} variant="thumb" priority={4} /> : <span className="conn-thumb-empty" aria-hidden="true" />}</span>
            <Link to={`/spore/${n}${q}`} className="conn-ref" aria-label={`Spore #${n}`}>
              <SporeRef id={n} palette={p ? p.palette : null} />
            </Link>
            <ConductivityIndicator d={Number(d)} dMax={dMax} dMin={dMin} />
            <Tooltip content="This tube’s √D as a share of R.">
              <span className="mono conn-share">{Math.round(shareOfR(d, o.reputation) * 100)}% of R</span>
            </Tooltip>
            <Link className="mono-s" to={networkLink(q, `${Math.min(o.id, n)}-${Math.max(o.id, n)}`)}>
              tube →
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Identity({ spore, you }: { spore: SporeView; you: boolean }) {
  const o = spore.organism;
  const pal = paletteOf(o.seed);
  // The name swells when a close raised R and thins when it fell (Design §3.5).
  const swell = useCloseSwell(spore.epoch, o.reputation);
  return (
    <div className="identity" style={{ '--accent': hex(pal.stops[3]) } as CSSProperties}>
      <h1 className="display-xl detail-name" key={swell.n} data-swell={swell.dir ?? undefined}>
        Spore #{o.id}
      </h1>
      <p className="body identity-line">
        <span className="swatch" aria-hidden="true" /> {pal.name} · <StateMarker reading={spore.status} /> ·{' '}
        <Tooltip content={<span className="mono">{o.seed}</span>}>
          <span className="mono">seed {o.seed.slice(0, 4)}…</span>
        </Tooltip>{' '}
        · <span className="mono">epoch {spore.epoch}</span>
      </p>
      <p className="body">
        Owned by{' '}
        <Tooltip content={<span className="mono">{spore.holding.owner}</span>}>
          <span className="mono">{shortAccount(spore.holding.owner)}</span>
        </Tooltip>{' '}
        {you && <span className="chip-you label">You</span>}
      </p>
    </div>
  );
}

export function SporeDetail() {
  const { id } = useParams();
  const { source, router, epoch } = useApp();
  const n = Number(id);
  const valid = /^\d+$/.test(id ?? '') && n <= 63;
  const s = useSpore(valid ? source : null, router, valid ? n : 0, epoch.info?.epoch);
  const g = useGallery(valid ? source : null, router, epoch.info?.epoch);
  const { config, error: configError } = useConfig(source?.kind === 'live' ? router : null);
  const log = useSporeRows(n);
  const wallet = useWallet();
  const [rendered, setRendered] = useState<(RenderedImage & { key: string }) | null>(null);
  const q = source ? sourceQuery(source) : '';

  if (!valid) {
    return (
      <>
        <PageHeader title="Spore" />
        <EmptyState title="No such spore">
          Spores are numbered 0 to 63. <Link to={`/market${q}`}>Browse the collection</Link>.
        </EmptyState>
      </>
    );
  }
  if (!source) return null;
  const spore = s.data;
  if (!spore) {
    return (
      <>
        <div className="detail-top">
          <Breadcrumb id={n} q={q} />
          <SourceBadge source={source} staleSince={epoch.staleSince} />
        </div>
        <h1 className="display-l">Spore #{n}</h1>
        {s.error ? (
          <ErrorState error={s.error} what={source.kind === 'live' ? `Spore #${n}` : `Spore #${n} from ${source.kind === 'sim' ? 'the simulation' : 'this recording'}`} onRetry={s.retry} />
        ) : (
          <p className="body" aria-busy="true">
            Reading Spore #{n} <LoadingBar ch={8} label={`Reading Spore #${n}`} />
          </p>
        )}
      </>
    );
  }

  const o = spore.organism;
  const live = source.kind === 'live';
  const staleAt = live && (epoch.staleSince != null || s.error) ? spore.readAt : null;
  const you = wallet.phase === 'connected' && wallet.accountId === spore.holding.owner;
  const a = spore.agent;
  const partners = g.data ? new Map(g.data.spores.map((x) => [x.organism.id, x.organism])) : null;
  // The bar's scale is the collection's strongest tube (Design §7 ConductivityIndicator), or this spore's while the collection loads.
  const allD = (g.data ? g.data.spores.flatMap((x) => x.organism.tubes) : o.tubes).map(([, d]) => Number(d));
  const dMax = Math.max(1, ...allD);
  const dMin = config ? Number(config.d_min) : 0;
  const current = rendered && rendered.key === artKey(o) ? rendered : null;
  const formula = allowanceFormula(a.budgetPerEpoch, o.reputation, config);

  return (
    <>
      <div className="detail-top">
        <Breadcrumb id={n} q={q} />
        <SourceBadge source={source} staleSince={epoch.staleSince} />
      </div>
      {s.error && <ErrorState error={s.error} what={`Spore #${n} again (showing what was read at ${formatClock(spore.readAt)})`} onRetry={s.retry} />}
      <div className="detail">
        <div className="detail-left">
          <div className="detail-art" style={{ viewTransitionName: `spore-art-${o.id}` }}>
            <SporeArtwork organism={o} glyph={spore.glyph} variant="full" priority={0} onRendered={(r) => setRendered(r)} />
          </div>
          <ArtCaption spore={spore} rendered={current} />
        </div>
        <div className="detail-right">
          <Identity spore={spore} you={you} />
          {live && router && <OwnerActions spore={spore} router={router} config={config} epoch={epoch.info} setupHref={`/spore/${o.id}${q}`} onChanged={s.retry} />}
          {!live && <p className="body unavailable">Owner actions sign on the live contract; this view reads {source.kind === 'sim' ? 'the simulation' : 'a recording'}.</p>}

          <div className="primary-figure">
            <Tooltip
              content={
                <>
                  R = Σ √D over its tubes; one tube at D 1.00 gives R 1.00. Raw <span className="mono">{o.reputation}</span>, computed by the contract at read time.
                </>
              }
            >
              <span className={`figure-l${staleAt !== null ? ' is-stale' : ''}`}>R {formatR(o.reputation)}</span>
            </Tooltip>
            <p className="body figure-note">Reputation is the sum of √D over its tubes. One full-strength tube is 1.00.</p>
          </div>
          <p className="body secondary-figures">
            Balance <BalanceDisplay yocto={spore.economy.balance} staleAt={staleAt} /> · Allowance <AllowanceDisplay economy={spore.economy} formula={formula} paused={a.paused} /> ·{' '}
            <Tooltip content="Epochs since activation, computed by the contract at read time.">
              <span className="mono">Age {o.age} epochs</span>
            </Tooltip>{' '}
            ·{' '}
            <Tooltip content="Tubes at or above d_min, as of the last close.">
              <span className="mono">
                {o.tubes.length} tube{o.tubes.length === 1 ? '' : 's'}
              </span>
            </Tooltip>
          </p>

          <Section title="Connections">
            <Connections spore={spore} partners={partners} dMax={dMax} dMin={dMin} q={q} />
            <p className="mono-s unavailable">D, the tube’s conductivity: settled flow between the two spores, less 25% decay at every close.</p>
          </Section>

          <Section title="Agent and policy">
            <p>
              <AgentStatus agent={a} status={spore.status.status} />
            </p>
            <dl className="policy">
              <dt className="label">Paused</dt>
              <dd className="mono">{a.paused ? 'yes' : 'no'}</dd>
              <dt className="label">Budget per epoch</dt>
              <dd>
                <BalanceDisplay yocto={a.budgetPerEpoch} />
              </dd>
              <dt className="label">Max payment</dt>
              <dd>
                <BalanceDisplay yocto={a.maxPayment} />
              </dd>
              <dt className="label">Allowed spores</dt>
              <dd className="mono">
                {a.allowAllSpores
                  ? 'all'
                  : a.allowlist.length === 0
                    ? 'none'
                    : a.allowlist.map((x) => (
                        <Link key={x} to={`/spore/${x}${q}`} aria-label={`Spore #${x}`}>
                          <SporeRef id={x} palette={partners?.get(x)?.palette ?? null} />
                        </Link>
                      ))}
              </dd>
              <dt className="label">External payees</dt>
              <dd className="mono">{a.externalAllowlist.length ? a.externalAllowlist.join(', ') : 'none'}</dd>
              <dt className="label">Effective budget</dt>
              <dd>
                <Tooltip
                  content={
                    <>
                      <span className="mono">{formula}</span>, that is min(owner budget, base + trust_gain × R), computed by the contract at read time.
                      {configError && ` (config failed: ${configError.message})`}
                    </>
                  }
                >
                  <span className="mono money">{formatNear(spore.economy.effectiveBudget)}</span>
                </Tooltip>
              </dd>
              <dt className="label">Spent this epoch</dt>
              <dd>
                {spore.economy.spentThisEpoch === null ? (
                  <Unavailable reason="This recording has no per-epoch spend; the live view shows it." />
                ) : (
                  <BalanceDisplay yocto={spore.economy.spentThisEpoch} />
                )}
              </dd>
              {spore.jobs && (
                <>
                  <dt className="label">Jobs now</dt>
                  <dd className="mono">
                    {spore.jobs.posted} posted · {spore.jobs.serving} serving
                  </dd>
                </>
              )}
            </dl>
          </Section>

          <Section title="Market">
            <p className="body">
              {spore.holding.listedPrice ? (
                <>
                  Listed for <span className="figure money">{formatNear(spore.holding.listedPrice)}</span>
                </>
              ) : (
                'Not listed'
              )}
            </p>
            <p className="mono">
              {spore.holding.sales ?? <Unavailable reason="This recording has no sales count; the live view shows it." />}{' '}
              {spore.holding.sales === 1 ? 'sale' : 'sales'} ·{' '}
              {spore.holding.transfers ?? <Unavailable reason="This recording has no transfer count; the live view shows it." />}{' '}
              {spore.holding.transfers === 1 ? 'transfer' : 'transfers'} · last sale{' '}
              <LastSale id={o.id} q={q} log={log} />
            </p>
          </Section>

          <Section title="Activity">
            <SporeActivity id={o.id} q={q} log={log} />
          </Section>

          <details className="technical">
            <summary className="heading">Technical</summary>
            <dl className="policy">
              <dt className="label">State</dt>
              <dd className="mono">
                epoch {spore.image.stateEpoch} ·{' '}
                {spore.image.stateHash ? <Hash h={spore.image.stateHash} /> : <Unavailable reason="No state hash is stored for this epoch (the contract writes one for each active spore at every close)." />}
              </dd>
              <dt className="label">Image commit</dt>
              <dd className="mono">
                {spore.image.commit ? (
                  <>
                    epoch {spore.image.commit.epoch} · state <Hash h={spore.image.commit.stateHash} /> · image <Hash h={spore.image.commit.imageHash} /> · renderer v
                    {spore.image.commit.rendererVersion}
                  </>
                ) : (
                  'none'
                )}
              </dd>
              <dt className="label">Seed</dt>
              <dd className="mono">
                <Hash h={o.seed} />
              </dd>
              <dt className="label">R (raw)</dt>
              <dd className="mono">{o.reputation}</dd>
              <dt className="label">D per tube (raw)</dt>
              <dd className="mono">{o.tubes.length ? o.tubes.map(([p, d]) => `#${p}: ${d}`).join(' · ') : 'none'}</dd>
              <dt className="label">Verify this image</dt>
              <dd>
                <SporeVerification spore={o.id} hasCommit={!!spore.image.commit} q={q} />
              </dd>
            </dl>
            {spore.token ? (
              <pre className="mono-s token-json">{JSON.stringify(spore.token, null, 2)}</pre>
            ) : (
              <p className="body">
                Token data <Unavailable reason="This recording doesn’t have it; the live view shows it." />
              </p>
            )}
          </details>
        </div>
      </div>
    </>
  );
}
