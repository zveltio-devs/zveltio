import './setup';
import { describe, it, expect, afterEach } from 'bun:test';
import { SyncManager } from '../sync-manager.js';
import { LocalStore } from '../local-store.js';
import type { ZveltioClient } from '../client.js';

/**
 * A client whose `get` answers the server's copy of a record — the only call the
 * realtime handler makes.
 */
function fakeClient(): ZveltioClient {
  return {
    collection: () => ({ get: async (id: string) => ({ id, title: 'from server' }) }),
  } as unknown as ZveltioClient;
}

/** Stands in for `ZveltioRealtime`; `push` delivers a frame as the socket would. */
function fakeRealtime() {
  let handler: ((msg: unknown) => unknown) | undefined;
  return {
    subscribe: (_collection: string, cb: (msg: unknown) => unknown) => {
      handler = cb;
      return () => {};
    },
    disconnect: () => {},
    push: async (msg: unknown) => handler?.(msg),
  };
}

let sync: SyncManager | undefined;
afterEach(async () => {
  await sync?.stop();
  sync = undefined;
});

describe('SyncManager — realtime frames as the engine sends them', () => {
  // The frame shape is `broadcastEvent` in packages/engine/src/routes/ws.ts.
  // The handler used to wait for `record.created` / `record_id`, names the
  // socket never sends, so no server push ever reached the local store.
  it('applies an insert and drops a delete without queueing one back', async () => {
    sync = new SyncManager(fakeClient(), { syncInterval: 60_000 });
    await sync.start();
    const store = (sync as unknown as { store: LocalStore }).store;
    await store.clear();
    const rt = fakeRealtime();
    (sync as unknown as { realtime: unknown }).realtime = rt;

    let latest: Array<{ id: string }> = [];
    sync.collection('posts').subscribe((records) => {
      latest = records;
    });

    await rt.push({ type: 'event', collection: 'posts', event: 'insert', data: { id: 'p1' } });
    expect((await store.get('posts', 'p1'))?.data).toMatchObject({ title: 'from server' });
    expect(latest.map((r) => r.id)).toEqual(['p1']);

    await rt.push({ type: 'event', collection: 'posts', event: 'delete', data: { id: 'p1' } });
    expect(await store.get('posts', 'p1')).toBeUndefined();
    // A queued delete here would send the server's own deletion back to it.
    expect(await store.getPendingOps()).toEqual([]);
  });
});

describe('SyncManager — stop() before start() settles', () => {
  // A React effect cleanup (and StrictMode, on every mount in development) calls
  // `stop()` while `start()` is still awaiting the store. `start()` then armed
  // the sync interval anyway, and nothing was left to clear it.
  it('leaves no timer armed', async () => {
    sync = new SyncManager(fakeClient(), { syncInterval: 60_000 });
    const starting = sync.start();
    await sync.stop();
    await starting;
    expect((sync as unknown as { syncTimer: unknown }).syncTimer).toBeNull();
  });
});
