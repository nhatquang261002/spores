// NEP-297 event logs (`EVENT_JSON:{…}`) from transaction outcomes: the
// router's own standard "spores" and NEP-171 "nep171" (mint, transfer).

export type EventStandard = 'spores' | 'nep171';

export interface ChainEvent {
  standard: EventStandard;
  version: string;
  event: string;
  data: any[];
  /** Receipt that logged it, when parsed from a tx outcome. */
  receiptId?: string;
}

const PREFIX = 'EVENT_JSON:';

/** One log line → event, or null for plain logs, other standards and malformed JSON. */
export function parseEventLog(line: unknown): ChainEvent | null {
  if (typeof line !== 'string' || !line.startsWith(PREFIX)) return null;
  let ev: any;
  try {
    ev = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (!ev || (ev.standard !== 'spores' && ev.standard !== 'nep171') || typeof ev.event !== 'string') return null;
  return { standard: ev.standard, version: String(ev.version ?? ''), event: ev.event, data: Array.isArray(ev.data) ? ev.data : [] };
}

/** Every event in a `tx` RPC result, in receipt order. */
export function eventsFromTx(tx: any): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const r of tx?.receipts_outcome ?? []) {
    for (const log of r?.outcome?.logs ?? []) {
      const ev = parseEventLog(log);
      if (ev) out.push({ ...ev, receiptId: r.id });
    }
  }
  return out;
}

/**
 * `epoch_closed` data (router/src/epoch.rs): the whole epoch input. Router4
 * epochs 1–16 also carry `tubes`; later closes carry only their count
 * (`edges`), and the tubes come from replay (core-wasm).
 */
export interface EpochClosed {
  epoch: number;
  fingerprint: string;
  prev_fingerprint: string;
  active: number[];
  flows: [number, number, string][];
  rejects: [number, number, number][];
  pool: string;
  edges: number;
  rebates: [number, string][];
  treasury: string;
  tubes?: [number, number, string][];
}

export function epochClosed(tx: any): EpochClosed | null {
  const ev = eventsFromTx(tx).find((e) => e.standard === 'spores' && e.event === 'epoch_closed');
  return ev ? (ev.data[0] as EpochClosed) : null;
}
