import { lazy, Suspense, useMemo } from 'react';
import { Link, Route, Routes, useLocation, useParams } from 'react-router';
import type { Router } from './chain/router';
import type { WalletClient } from './chain/wallet';
import { Activity } from './pages/Activity';
import { Market } from './pages/Market';
import { Network } from './pages/Network';
import { MySpores } from './pages/MySpores';
import { Overview } from './pages/Overview';
import { NotFound } from './pages/Pages';
import { SporeDetail } from './pages/SporeDetail';
import { Verify } from './pages/Verify';
import { liveRouter } from './sources/live';
import { parseSource } from './sources/source';
import { useEpochInfo } from './state/epoch';
import { AppContext, type AppState } from './state/source';
import { VerifyProvider } from './state/verify';
import { WalletProvider } from './state/wallet';
import { useReducedMotion } from './ui/motion';
import { LandingFrame, Shell } from './ui/Shell';
import { EmptyState, ErrorState, LoadingBar } from './ui/states';
import { TxTrayProvider } from './ui/TxTray';

// The Demo Lab loads on its own: its stage isn't part of the first paint of any other page.
const DemoLab = lazy(() => import('./pages/DemoLab').then((m) => ({ default: m.DemoLab })));
const LoopScene = lazy(() => import('./pages/LoopScene').then((m) => ({ default: m.LoopScene })));
const RogueScene = lazy(() => import('./pages/RogueScene').then((m) => ({ default: m.RogueScene })));
const SaleScene = lazy(() => import('./pages/SaleScene').then((m) => ({ default: m.SaleScene })));
const WashScene = lazy(() => import('./pages/WashScene').then((m) => ({ default: m.WashScene })));

function LabScene() {
  const { scene } = useParams();
  const page = scene === 'loop' ? <LoopScene /> : scene === 'rogue' ? <RogueScene /> : scene === 'sale' ? <SaleScene /> : scene === 'wash' ? <WashScene /> : null;
  if (page) return <Suspense fallback={<LoadingBar label="Loading the scene" ch={12} />}>{page}</Suspense>;
  return (
    <EmptyState title="There is no scene at this address">
      <Link to="/lab">Go to the Demo Lab</Link>.
    </EmptyState>
  );
}

/** Routes (Design §5.1) inside the shell. `router` and `wallet` are injectable for tests; the defaults are the live router and near-connect. */
export function App({ router, wallet }: { router?: Router; wallet?: WalletClient }) {
  const { search } = useLocation();
  const reducedMotion = useReducedMotion();
  const [source, sourceError] = useMemo(() => {
    try {
      return [parseSource(search), null] as const;
    } catch (e) {
      return [null, (e as Error).message] as const;
    }
  }, [search]);
  const live = source?.kind === 'live' ? (router ?? liveRouter()) : null;
  const epoch = useEpochInfo(live);
  const state: AppState = { source, sourceError, epoch, router: live, reducedMotion };

  return (
    <AppContext.Provider value={state}>
      <WalletProvider client={wallet}>
      <VerifyProvider source={source} router={live} rpcRouter={router}>
      <TxTrayProvider>
        {sourceError ? (
          <Shell>
            <ErrorState error={new Error(sourceError)} what="this source" />
          </Shell>
        ) : (
          <Routes>
            <Route element={<LandingFrame />}>
              <Route index element={<Overview />} />
            </Route>
            <Route element={<Shell />}>
              <Route path="network" element={<Network />} />
              <Route path="mine" element={<MySpores />} />
              <Route path="market" element={<Market />} />
              <Route path="activity" element={<Activity />} />
              <Route path="spore/:id" element={<SporeDetail />} />
              <Route path="lab" element={<Suspense fallback={<LoadingBar label="Loading the Demo Lab" ch={12} />}><DemoLab /></Suspense>} />
              <Route path="lab/:scene" element={<LabScene />} />
              <Route path="verify" element={<Verify />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        )}
      </TxTrayProvider>
      </VerifyProvider>
      </WalletProvider>
    </AppContext.Provider>
  );
}
