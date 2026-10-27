/**
 * A failed `GET /api/data` used to look like a user with no collections: an
 * empty navigation and a 404 on every collection URL. The layout now reports
 * the failure, so the shell can say so and a collection page answers 503.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/guards.js', () => ({ requireUser: async () => ({ user: { id: 'u1' } }) }));

const { load } = await import('./+layout');

const run = (fetch: typeof globalThis.fetch) =>
  load({
    fetch,
    url: new URL('http://x/app'),
    untrack: (f: () => unknown) => f(),
  } as unknown as Parameters<typeof load>[0]) as Promise<{
    collections: unknown[];
    collectionsFailed: boolean;
  }>;

describe('/app layout load', () => {
  it('reports a failed collection list instead of an empty one', async () => {
    const out = await run(async (u) =>
      String(u).endsWith('/api/data') ? new Response('{}', { status: 500 }) : new Response('{}'),
    );
    expect(out.collections).toEqual([]);
    expect(out.collectionsFailed).toBe(true);
  });

  it('an unreachable engine is a failure too', async () => {
    const out = await run(async () => {
      throw new TypeError('fetch failed');
    });
    expect(out.collectionsFailed).toBe(true);
  });

  it('a successful list is not a failure', async () => {
    const out = await run(async () => Response.json({ collections: [{ name: 'tasks' }] }));
    expect(out.collections).toEqual([{ name: 'tasks' }]);
    expect(out.collectionsFailed).toBe(false);
  });
});
