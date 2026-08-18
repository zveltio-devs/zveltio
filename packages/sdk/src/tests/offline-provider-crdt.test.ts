import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LocalStore } from '../local-store.js';
import { createOfflineProvider } from '../offline/index.js';

/**
 * The CRDT provider is the DEFAULT (`config.provider ?? 'crdt'`) and it did
 * nothing at all: `pull()` was an empty body, `subscribe()` returned an
 * unsubscribe for nothing, and `push()` returned `0` — which reads as "there
 * was nothing to send" rather than "I did not look". An application that called
 * `createOfflineProvider({ engineUrl })` and pushed on a timer got a clean run
 * and an empty server, forever, with nothing in any log.
 *
 * The test that existed asserted exactly that: `await expect(p.push())
 * .resolves.toBe(0)`, under the title "builds a working stub". It passed for the
 * whole life of the defect.
 *
 * So these assert the crossing — what ends up in the local store, and what the
 * count means — rather than that the methods are callable.
 */

const ENGINE = 'http://engine.test';

/** Rows the fake engine holds, by collection. */
let served: Record<string, Array<Record<string, unknown>>> = {};
/** Every request the provider made, so "did it even ask" is answerable. */
let requests: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  served = {};
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    requests.push(`${init?.method ?? 'GET'} ${url.replace(ENGINE, '')}`);
    const match = url.match(/\/api\/data\/([^/?]+)/);
    const name = match?.[1] ?? '';
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    // One page only: page 2 comes back empty, which is how `pull` stops.
    const data = page === 1 ? (served[name] ?? []) : [];
    return new Response(JSON.stringify({ data, total: data.length, page, limit: 200 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const store = new LocalStore();
  await store.open();
  await store.clear();
  await store.close();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function localRows(collection: string) {
  const store = new LocalStore();
  await store.open();
  const rows = await store.list(collection);
  await store.close();
  return rows;
}

describe('createOfflineProvider — the crdt path actually syncs', () => {
  it('is the default provider, which is why the no-op mattered', async () => {
    const p = await createOfflineProvider({ engineUrl: ENGINE });
    expect(p.kind).toBe('crdt');
    await p.close();
  });

  it('pull writes the server rows into the local store', async () => {
    served.orders = [
      { id: 'o-1', total: 10, status: 'new' },
      { id: 'o-2', total: 20, status: 'paid' },
    ];

    const p = await createOfflineProvider({ engineUrl: ENGINE, tables: ['orders'] });
    await p.pull();
    await p.close();

    const rows = await localRows('orders');
    expect(rows.map((r) => r.id).sort()).toEqual(['o-1', 'o-2']);
    expect(rows.find((r) => r.id === 'o-1')?.data.total).toBe(10);
    // The old implementation made no request at all. This is the assertion that
    // would have caught it.
    expect(requests.some((r) => r.startsWith('GET /api/data/orders'))).toBe(true);
  });

  it('pull refuses an empty table list instead of quietly doing nothing', async () => {
    // Silence here is exactly what the no-op was. A provider asked to replicate
    // nothing is a configuration mistake, and an empty local database looks the
    // same as an empty server.
    const p = await createOfflineProvider({ engineUrl: ENGINE });
    await expect(p.pull()).rejects.toThrow(/tables.*is empty/i);
    await p.close();
  });

  it('push reports how many queued operations it actually sent', async () => {
    const p = await createOfflineProvider({ engineUrl: ENGINE, tables: ['orders'] });

    // Queue two local writes the way an offline application does.
    const store = new LocalStore();
    await store.open();
    await store.put('orders', 'o-9', { total: 99 });
    await store.put('orders', 'o-10', { total: 100 });
    const queued = await store.getPendingOps();
    await store.close();
    expect(queued.length).toBe(2);

    const sent = await p.push();
    await p.close();

    expect(sent).toBe(2);
    // Not just a number: the writes have to have left the machine.
    expect(requests.filter((r) => r.startsWith('POST /api/data/orders')).length).toBe(2);
  });

  it('subscribe delivers the local rows, and the unsubscribe stops delivery', async () => {
    served.orders = [{ id: 'o-1', total: 10 }];
    const p = await createOfflineProvider({ engineUrl: ENGINE, tables: ['orders'] });
    await p.pull();

    const seen: unknown[][] = [];
    const off = p.subscribe('orders', (rows) => seen.push(rows));
    await Bun.sleep(20);
    expect(seen.length).toBeGreaterThan(0);
    expect((seen.at(-1) as Array<{ id: string }>).map((r) => r.id)).toEqual(['o-1']);

    off();
    const countAtUnsubscribe = seen.length;
    // A second pull notifies listeners; an unsubscribed callback must not hear it.
    await p.pull();
    await Bun.sleep(20);
    expect(seen.length).toBe(countAtUnsubscribe);

    await p.close();
  });
});
