// IndexedDB image cache for rendered art (Design §10). Entries are raw RGB
// (786,432 bytes each) plus the image hash, keyed by renderer version and the
// render input's sha256 (renderQueue.ts). The oldest entries are dropped past
// MAX_ENTRIES. Where IndexedDB is unavailable (private mode, blocked storage)
// there is no cache and every visit renders.
import type { CachedImage, ImageCacheLike } from './renderQueue';

const DB = 'spores-art';
const STORE = 'images';
/** About 150 MB of RGB. */
export const MAX_ENTRIES = 200;

interface Row extends CachedImage {
  key: string;
  at: number;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export class IdbImageCache implements ImageCacheLike {
  private readonly db: IDBDatabase;
  private puts = 0;
  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  /** Opens the cache, or resolves null where IndexedDB can't be used. */
  static async open(idb: IDBFactory | null = globalThis.indexedDB ?? null, name = DB): Promise<IdbImageCache | null> {
    if (!idb) return null;
    try {
      const open = idb.open(name, 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('at', 'at');
      };
      return new IdbImageCache(await req(open));
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<CachedImage | undefined> {
    const row = (await req(this.db.transaction(STORE).objectStore(STORE).get(key))) as Row | undefined;
    return row && { rgb: row.rgb, imageHash: row.imageHash };
  }

  async put(key: string, value: CachedImage): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    await req(tx.objectStore(STORE).put({ key, rgb: value.rgb, imageHash: value.imageHash, at: Date.now() } satisfies Row));
    if (++this.puts % 16 === 0) await this.trim();
  }

  async count(): Promise<number> {
    return req(this.db.transaction(STORE).objectStore(STORE).count());
  }

  /** Deletes the oldest entries beyond `max`. */
  async trim(max = MAX_ENTRIES): Promise<void> {
    const store = this.db.transaction(STORE, 'readwrite').objectStore(STORE);
    let extra = (await req(store.count())) - max;
    if (extra <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const cur = store.index('at').openCursor();
      cur.onerror = () => reject(cur.error);
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || extra <= 0) return resolve();
        c.delete();
        extra--;
        c.continue();
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
