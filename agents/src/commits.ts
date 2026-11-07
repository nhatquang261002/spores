// Image commits run beside the keeper's close loop, so a close never waits for
// renders or commit txs (Phase 6 S2; at 9 spores they stretched 30 s epochs
// to about 100 s). A commit is valid only until the next close: the router
// checks it against the spore's latest state hash. So a newer batch, or
// `stop()` just before a close, makes what is left of the older batch stale,
// and stale items are skipped, never sent.

/** `live()` turns false once the item's batch is stale; check it before sending. */
export type Commit<T> = (item: T, live: () => boolean) => Promise<void>;

export class CommitQueue<T> {
  private gen = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly commit: Commit<T>;
  private readonly skip: (item: T) => void;

  constructor(commit: Commit<T>, skip: (item: T) => void) {
    this.commit = commit;
    this.skip = skip;
  }

  /** Queues a batch behind the running one, whose remaining items become stale. */
  run(items: T[]): void {
    const gen = ++this.gen;
    const live = () => gen === this.gen;
    this.tail = this.tail.then(async () => {
      for (const item of items) {
        if (!live()) this.skip(item);
        else await this.commit(item, live).catch(() => {});
      }
    });
  }

  /** Marks the current batch stale; call it right before closing the epoch. */
  stop(): void {
    this.gen++;
  }

  /** Resolves once every queued batch has finished or been skipped. */
  idle(): Promise<void> {
    return this.tail;
  }
}
