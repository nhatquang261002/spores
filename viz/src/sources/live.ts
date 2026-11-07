// LIVE source: testnet RPC against the router named by VITE_ROUTER (default
// router4). Endpoints come from VITE_NEAR_RPCS (comma-separated) or the
// defaults in chain/rpc.ts.
import { Rpc } from '../chain/rpc';
import { Router } from '../chain/router';
import { DEFAULT_ROUTER } from './source';

let shared: Router | null = null;

export function rpcUrlsFromEnv(value: string | undefined): string[] | undefined {
  const urls = (value ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : undefined;
}

/** One Router (and so one RPC rotation and backoff state) for the whole app. */
export function liveRouter(): Router {
  if (!shared) shared = new Router(new Rpc({ urls: rpcUrlsFromEnv(import.meta.env?.VITE_NEAR_RPCS) }), DEFAULT_ROUTER);
  return shared;
}
