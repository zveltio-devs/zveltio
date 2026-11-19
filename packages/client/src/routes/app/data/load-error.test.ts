/**
 * The engine answers errors as problem+json (`detail`), not `{ error }`. The
 * data loaders read only `error`, so every refusal showed the generic
 * "load failed" instead of the engine's reason.
 */

import { describe, expect, it } from 'vitest';

const { load } = await import('./[collection]/[id]/+page');

describe('/app/data record load', () => {
  it("shows the engine's problem detail", async () => {
    const fetch = async () =>
      Response.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'forbidden',
          detail: 'no read on tasks',
        },
        { status: 403 },
      );
    const run = load({
      fetch,
      params: { collection: 'tasks', id: 'r1' },
      parent: async () => ({
        collections: [{ name: 'tasks', fields: [] }],
        collectionsFailed: false,
        engineUrl: 'http://e',
      }),
    } as unknown as Parameters<typeof load>[0]);
    await expect(run).rejects.toMatchObject({ status: 403, body: { message: 'no read on tasks' } });
  });
});
