// The app-wide source (from `?source=`) and the live epoch state, shared by
// the shell and the pages.
import { createContext, useContext } from 'react';
import type { Router } from '../chain/router';
import type { Source } from '../model/types';
import type { EpochState } from './epoch';

export interface AppState {
  /** null when `?source=` could not be parsed; `sourceError` says why. */
  source: Source | null;
  sourceError: string | null;
  epoch: EpochState;
  /** The live router; null for other sources. */
  router: Router | null;
  reducedMotion: boolean;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const s = useContext(AppContext);
  if (!s) throw new Error('useApp outside AppContext');
  return s;
}
