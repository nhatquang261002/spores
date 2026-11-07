import { describe, expect, it } from 'vitest';
import { epochClosed, eventsFromTx, parseEventLog } from '../src/chain/events';

const log = (v: unknown) => `EVENT_JSON:${JSON.stringify(v)}`;

describe('events', () => {
  it('parses spores and nep171 events and ignores everything else', () => {
    expect(parseEventLog(log({ standard: 'spores', version: '1.0.0', event: 'job_settled', data: [{ job_id: 4 }] }))).toEqual({
      standard: 'spores',
      version: '1.0.0',
      event: 'job_settled',
      data: [{ job_id: 4 }],
    });
    expect(parseEventLog(log({ standard: 'nep171', version: '1.2.0', event: 'nft_transfer', data: [{ memo: 'sale' }] }))?.event).toBe('nft_transfer');
    expect(parseEventLog(log({ standard: 'nep141', version: '1', event: 'ft_transfer', data: [] }))).toBeNull();
    expect(parseEventLog('plain log line')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{broken')).toBeNull();
    expect(parseEventLog(42)).toBeNull();
  });

  it('collects events from every receipt in order, with the receipt id', () => {
    const tx = {
      receipts_outcome: [
        { id: 'R1', outcome: { logs: [log({ standard: 'spores', version: '1.0.0', event: 'a', data: [] }), 'x'] } },
        { id: 'R2', outcome: { logs: [log({ standard: 'nep171', version: '1.2.0', event: 'b', data: [] })] } },
      ],
    };
    expect(eventsFromTx(tx).map((e) => [e.event, e.receiptId])).toEqual([
      ['a', 'R1'],
      ['b', 'R2'],
    ]);
    expect(eventsFromTx(null)).toEqual([]);
  });

  it('finds epoch_closed with or without tubes', () => {
    const data = {
      epoch: 21,
      fingerprint: 'ab'.repeat(32),
      prev_fingerprint: 'cd'.repeat(32),
      active: [0, 1],
      flows: [[0, 1, '1000']],
      rejects: [],
      pool: '10',
      edges: 1,
      rebates: [],
      treasury: '0',
    };
    const tx = { receipts_outcome: [{ id: 'R', outcome: { logs: [log({ standard: 'spores', version: '1.0.0', event: 'epoch_closed', data: [data] })] } }] };
    expect(epochClosed(tx)).toEqual(data);
    expect(epochClosed(tx)?.tubes).toBeUndefined();
    expect(epochClosed({ receipts_outcome: [] })).toBeNull();
  });
});
