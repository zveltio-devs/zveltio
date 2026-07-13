/**
 * Phase C — virtual handlers map non-Error throws to 502 (handlers/list.ts + single.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hverr_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-err-api',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.items',
  id_field: 'id',
};

d('data virtual non-Error failures (in-process)', () => {
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
        virtual_config: JSON.stringify(VIRTUAL_CONFIG),
        fields: JSON.stringify([
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

  it('returns 502 with a generic message when virtual list fetch throws a string', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw 'upstream string failure';
    }) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail?: string; error?: string };
    expect(body.detail ?? body.error).toBe('Virtual source error');
  });

  it('returns 502 with a generic message when virtual get-one fetch throws a string', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw 'get blew up';
    }) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000001`, {
      headers: { cookie },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail?: string; error?: string };
    expect(body.detail ?? body.error).toBe('Virtual source error');
  });
});
