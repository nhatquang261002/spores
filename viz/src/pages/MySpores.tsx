// My Spores `/mine` (Design §5.1, §6.B): the spores the connected wallet owns
// on the live router (`nft_tokens_for_owner`, paged), as gallery cards from
// the same bulk read as the Marketplace. Wallet identity comes from the
// wallet; ownership comes from the router.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { SporeCard } from '../components/SporeCard';
import '../components/gallery.css';
import { shortRouter, sourceQuery } from '../sources/source';
import { useGallery } from '../state/gallery';
import { useApp } from '../state/source';
import { useWallet } from '../state/wallet';
import { EmptyState, ErrorState, LoadingBar } from '../ui/states';
import { PageHeader } from './Pages';

/** Owned ids, read again at each observed close (a sale or transfer shows by then at the latest). */
function useOwned(account: string | null, liveEpoch: number | undefined) {
  const { router } = useApp();
  const [state, setState] = useState<{ account: string; ids: number[] } | { account: string; error: Error } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!router || !account) return setState(null);
    let live = true;
    router.idsOwnedBy(account).then(
      (ids) => live && setState({ account, ids }),
      (e) => live && setState({ account, error: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => {
      live = false;
    };
  }, [router, account, attempt, liveEpoch]);
  const current = state && state.account === account ? state : null;
  return { state: current, retry: () => setAttempt((a) => a + 1) };
}

export function MySpores() {
  const { source, router, epoch, reducedMotion } = useApp();
  const wallet = useWallet();
  const account = wallet.phase === 'connected' ? wallet.accountId : null;
  const owned = useOwned(source?.kind === 'live' ? account : null, epoch.info?.epoch);
  const g = useGallery(source?.kind === 'live' && account ? source : null, router, epoch.info?.epoch);
  if (!source) return null;

  const header = <PageHeader title="My Spores" />;
  if (source.kind !== 'live')
    return (
      <>
        {header}
        <EmptyState title="My Spores reads the live router">
          Ownership is on chain, and this view reads {source.kind === 'sim' ? 'the simulation' : 'a recording'}. <Link to="/mine">Open My Spores on LIVE</Link>.
        </EmptyState>
      </>
    );
  if (wallet.phase === 'disconnected' || wallet.phase === 'connecting')
    return (
      <>
        {header}
        <EmptyState title="Connect a wallet to see the spores it owns">
          <button type="button" className="btn btn-primary" onClick={wallet.connect} disabled={wallet.phase === 'connecting'}>
            {wallet.phase === 'connecting' ? 'Connecting…' : 'Connect wallet'}
          </button>
        </EmptyState>
      </>
    );
  if (wallet.phase === 'wrong-network')
    return (
      <>
        {header}
        <EmptyState title="Switch to testnet">
          <span className="mono">{wallet.accountId}</span> is not a testnet account. Disconnect from the wallet menu, then connect a testnet account.
        </EmptyState>
      </>
    );

  const where = shortRouter(source.router);
  const st = owned.state;
  if (st && 'error' in st)
    return (
      <>
        {header}
        <ErrorState error={st.error} what={`the spores ${account} owns`} onRetry={owned.retry} />
      </>
    );
  if (!g.data && g.error)
    return (
      <>
        {header}
        <ErrorState error={g.error} what="the collection" onRetry={g.retry} />
      </>
    );
  if (!st || !g.data)
    return (
      <>
        {header}
        <p className="body" aria-busy="true">
          Reading the spores <span className="mono">{account}</span> owns on <span className="mono">{where}</span> <LoadingBar ch={8} label="Reading owned spores" />
        </p>
      </>
    );
  if (st.ids.length === 0)
    return (
      <>
        {header}
        <EmptyState title={`${account} owns no spores on ${where}`}>
          Buy one that is listed in the <Link to="/market?view=listed">Marketplace</Link>.
        </EmptyState>
      </>
    );

  const mine = new Set(st.ids);
  const cards = g.data.spores.filter((s) => mine.has(s.organism.id));
  const q = sourceQuery(source);
  return (
    <>
      {header}
      <p className="body mine-line">
        <span className="mono">{account}</span> owns {st.ids.length} spore{st.ids.length === 1 ? '' : 's'} on <span className="mono">{where}</span>. Open one to act as its
        owner.
      </p>
      <ul className="gallery-grid" aria-label={`${cards.length} spores owned by ${account}`}>
        {cards.map((s, i) => (
          <SporeCard
            key={s.organism.id}
            spore={s}
            to={`/spore/${s.organism.id}${q}`}
            from={{ label: 'My Spores', to: `/mine${q}` }}
            tabIndex={0}
            priority={1 + i}
            viewTransition={!reducedMotion}
          />
        ))}
      </ul>
    </>
  );
}
