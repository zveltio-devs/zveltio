/**
 * Phase C — virtual list scalar filter shorthand (handlers/list.ts eq branch).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvscf_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-scalar-api',
  auth_type: 'none',
  field_mapping: { title: 'name' },
  list_path: '$.items',
  id_field: 'id',
  supported_operators: ['eq'],
};

d('data virtual list scalar filter (in-process)', () => {
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

  it('translates a scalar filter value as eq on the mapped field', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain('name=needle');
      expect(u).not.toContain('%5Beq%5D');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 's1', name: 'needle' }],
          total: 1,
        }),
      };
    }) as unknown as typeof fetch;

    const filter = encodeURIComponent(JSON.stringify({ title: 'needle' }));
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title?: string }> };
    expect(body.records[0]?.title).toBe('needle');
  });
});
