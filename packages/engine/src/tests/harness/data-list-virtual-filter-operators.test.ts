/**
 * Phase C — virtual list nested filter operators (handlers/list.ts virtual branch).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvfo_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-filter-ops',
  auth_type: 'none',
  field_mapping: { min_score: 'points_gt', max_score: 'points_lte', status: 'status_neq' },
  list_path: '$.items',
  id_field: 'id',
  supported_operators: ['eq', 'neq', 'gt', 'gte', 'lte'],
};

d('data virtual list filter operators (in-process)', () => {
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
          { name: 'min_score', type: 'number', required: false, unique: false, indexed: false },
          { name: 'max_score', type: 'number', required: false, unique: false, indexed: false },
          { name: 'status', type: 'number', required: false, unique: false, indexed: false },
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

  it('translates nested neq/gt/lte filters to upstream query params', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain('status_neq%5Bneq%5D=0');
      expect(u).toContain('points_gt%5Bgt%5D=10');
      expect(u).toContain('points_lte%5Blte%5D=99');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'f1', status_neq: 1, points_gt: 42, points_lte: 42 }],
          total: 1,
        }),
      };
    }) as unknown as typeof fetch;

    const filter = encodeURIComponent(
      JSON.stringify({
        status: { neq: 0 },
        min_score: { gt: 10 },
        max_score: { lte: 99 },
      }),
    );
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ status?: number }> };
    expect(body.records[0]?.status).toBe(1);
  });
});
