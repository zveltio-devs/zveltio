import { describe, it, expect } from 'bun:test';
import {
  createOfflineProvider,
  ElectricNotConfigured,
  ElectricUnavailable,
} from '@zveltio/sdk/offline';

/**
 * S5-07 full — offline-sync provider factory.
 *
 * `crdt` is the default working path. `electric` follows the engine's shape
 * endpoint (`/api/electric/v1/shape`); a stub engine speaks the Shape protocol
 * here, and tests/harness/electric-shapes.test.ts drives a real Electric.
 */

/**
 * The CRDT half of this file is gone, deliberately.
 *
 * It used to read:
 *
 *   it('builds a working stub for the default crdt provider', ...)
 *   await expect(p.push()).resolves.toBe(0);
 *
 * which was accurate — the provider WAS a stub — and passed for the whole life
 * of the defect while certifying that the default sync path did nothing. A test
 * asserting the current behaviour of a placeholder is not coverage; it is a lock
 * on the placeholder.
 *
 * The provider now opens a real local store, which needs IndexedDB, and
 * `fake-indexeddb` is a dependency of the SDK package rather than this one. So
 * the CRDT path is asserted where it can actually be driven:
 * `packages/sdk/src/tests/offline-provider-crdt.test.ts` — rows land in the
 * store, `push()` counts what left the machine, `subscribe()` stops on
 * unsubscribe, and an empty `tables` list is refused rather than answered with
 * silence.
 *
 * What remains here is the Electric path, which needs the stub engine below.
 */

// ── A stub engine speaking the Shape protocol ─────────────────────────────

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** Answers each request with the next reply, and records the URLs asked. */
function stubEngine(replies: Reply[]) {
  const urls: URL[] = [];
  const fetchStub = (async (input: string | URL, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    const r = replies.shift();
    if (!r) {
      // A live poll with nothing left to say: hang until aborted, as a long-poll does.
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchStub, urls };
}

const row = (id: string, value: Record<string, unknown>, operation = 'insert') => ({
  key: `"public"."zvd_notes"/"${id}"`,
  value: { id, ...value },
  headers: { operation },
});
const upToDate = { headers: { control: 'up-to-date' } };
const at = (offset: string) => ({ 'electric-offset': offset, 'electric-handle': 'h1' });

describe('createOfflineProvider — electric provider', () => {
  it('syncs each table through the engine at creation, naming only the collection', async () => {
    const { fetchStub, urls } = stubEngine([
      { status: 200, body: [row('1', { title: 'a' })], headers: at('0_0') },
      { status: 200, body: [upToDate], headers: at('0_inf') },
    ]);
    const p = await createOfflineProvider({
      engineUrl: 'http://engine',
      provider: 'electric',
      tables: ['zvd_notes'],
      fetch: fetchStub,
    });
    expect(p.kind).toBe('electric');
    expect(urls.map((u) => u.pathname + u.search)).toEqual([
      '/api/electric/v1/shape?collection=notes&offset=-1',
      '/api/electric/v1/shape?collection=notes&offset=0_0&handle=h1',
    ]);
    await expect(p.push()).rejects.toThrow(/reads only/);
    await p.close();
  });

  it('subscribe applies inserts, partial updates and deletes, then follows live', async () => {
    const { fetchStub, urls } = stubEngine([
      {
        status: 200,
        body: [row('1', { title: 'a', n: 1 }), row('2', { title: 'b' }), upToDate],
        headers: at('0_inf'),
      },
      {
        status: 200,
        body: [row('1', { title: 'a2' }, 'update'), row('2', {}, 'delete'), upToDate],
        headers: { ...at('5_0'), 'electric-cursor': 'c9' },
      },
    ]);
    const p = await createOfflineProvider({
      engineUrl: 'http://engine',
      provider: 'electric',
      fetch: fetchStub,
    });
    const seen: unknown[][] = [];
    const off = p.subscribe('notes', (rows) => seen.push(rows));
    for (let i = 0; i < 50 && seen.length < 2; i++) await Bun.sleep(5);
    expect(seen).toEqual([
      [
        { id: '1', title: 'a', n: 1 },
        { id: '2', title: 'b' },
      ],
      [{ id: '1', title: 'a2', n: 1 }],
    ]);
    await Bun.sleep(5);
    expect(urls[1]!.searchParams.get('live')).toBe('true');
    expect(urls[2]!.searchParams.get('cursor')).toBe('c9');
    off();
    await p.close();
  });

  it('a must-refetch restarts the shape from offset -1 and drops the old rows', async () => {
    const { fetchStub, urls } = stubEngine([
      { status: 200, body: [row('1', { title: 'old' }), upToDate], headers: at('0_inf') },
      { status: 409, body: { code: 'electric.must_refetch' } },
      { status: 200, body: [row('2', { title: 'new' }), upToDate], headers: at('0_inf') },
    ]);
    const p = await createOfflineProvider({
      engineUrl: 'http://engine',
      provider: 'electric',
      fetch: fetchStub,
    });
    const seen: unknown[][] = [];
    p.subscribe('notes', (rows) => seen.push(rows));
    for (let i = 0; i < 50 && seen.length < 3; i++) await Bun.sleep(5);
    expect(seen).toEqual([[{ id: '1', title: 'old' }], [], [{ id: '2', title: 'new' }]]);
    expect(urls[2]!.searchParams.get('offset')).toBe('-1');
    expect(urls[2]!.searchParams.has('handle')).toBe(false);
    await p.close();
  });

  for (const [status, body, text] of [
    [503, { error: 'ELECTRIC_URL must be set' }, 'ELECTRIC_URL'],
    [
      409,
      { code: 'electric.unfilterable', detail: 'an extension decides row access' },
      'unfilterable',
    ],
    [401, {}, '401'],
    [403, { error: 'Forbidden' }, 'Forbidden'],
  ] as const) {
    it(`creation throws ElectricUnavailable when the engine answers ${status}`, async () => {
      const { fetchStub } = stubEngine([{ status, body }]);
      let caught: Error | null = null;
      try {
        await createOfflineProvider({
          engineUrl: 'http://engine',
          provider: 'electric',
          tables: ['notes'],
          fetch: fetchStub,
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeInstanceOf(ElectricUnavailable);
      expect(caught!.message).toContain(text);
    });
  }

  it('ElectricNotConfigured ctor still exports correctly', () => {
    const e = new ElectricNotConfigured('test');
    expect(e.name).toBe('ElectricNotConfigured');
  });
});
