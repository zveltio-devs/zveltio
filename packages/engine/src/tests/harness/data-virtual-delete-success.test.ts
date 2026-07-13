/**
 * Phase C — virtual DELETE treats upstream 204/404 as success (handlers/single.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvdelok_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-del-ok',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.items',
  id_field: 'id',
};

d('data virtual delete success paths (in-process)', () => {
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

  it('returns success when the virtual upstream responds with 204', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 204,
      text: async () => '',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000099`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
  });
});
