/**
 * Phase C — virtual list skips malformed filter JSON (handlers/list.ts catch branch).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvbadf_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-bad-filter',
  auth_type: 'none',
  field_mapping: { title: 'name' },
  list_path: '$.items',
  id_field: 'id',
};

d('data virtual list malformed filter JSON (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    await db
      .insertInto('zvd_collections')
      .values({
        name: COLLECTION,
        display_name: COLLECTION,
        icon: 'Table',
        route_group: 'private',
        is_permissioned: true,
        is_managed: true,
        is_system: false,
        schema_locked: false,
        sort: 99,
        singular_name: COLLECTION,
        source_type: 'virtual',
        virtual_config: toJsonb(VIRTUAL_CONFIG),
        fields: toJsonb([
          { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        ]),
      })
      .execute();
    DDLManager.invalidateCache(COLLECTION);
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    DDLManager.invalidateCache(COLLECTION);
  });

  it('returns 200 and lists upstream data when filter JSON is invalid', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'v1', name: 'ok' }], total: 1 }),
    })) as unknown as typeof fetch;

    const res = await app.request(
      `/api/data/${COLLECTION}?filter=${encodeURIComponent('{not-json')}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title?: string }> };
    expect(body.records[0]?.title).toBe('ok');
  });
  // An empty operator object (`{"id":{}}`) threw on the destructure into the
  // catch above, which dropped every filter after it: a BROADER result with a 200.
  it('skips an empty operator object and keeps the filters after it', async () => {
    originalFetch = globalThis.fetch;
    let dialed = '';
    globalThis.fetch = (async (url: string | URL) => {
      dialed = String(url);
      return { ok: true, status: 200, json: async () => ({ items: [], total: 0 }) };
    }) as unknown as typeof fetch;

    const filter = JSON.stringify({ id: {}, title: { eq: 'kept' } });
    const res = await app.request(`/api/data/${COLLECTION}?filter=${encodeURIComponent(filter)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(new URL(dialed).searchParams.get('name')).toBe('kept');
  });
});
