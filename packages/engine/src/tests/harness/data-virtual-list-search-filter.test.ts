/**
 * Phase C — virtual list search + filter ops through handlers/list.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvlst_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-list-api',
  auth_type: 'none',
  field_mapping: { title: 'name' },
  list_path: '$.items',
  id_field: 'id',
  supported_operators: ['eq', 'gt', 'neq', 'in'],
};

d('data virtual list search and filters (in-process)', () => {
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
          { name: 'score', type: 'number', required: false, unique: false, indexed: false },
          { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
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

  it('forwards ?search= to the virtual upstream URL', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain('search=needle');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 's1', name: 'needle-hit' }],
          total: 1,
        }),
      };
    }) as unknown as typeof fetch;

    const res = await app.request(
      `/api/data/${COLLECTION}?search=${encodeURIComponent('needle')}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title?: string }> };
    expect(body.records[0]?.title).toBe('needle-hit');
  });

  it('translates gt/neq/in filters and field_mapping on virtual list', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain('score%5Bgt%5D=10');
      expect(u).toContain('name%5Bneq%5D=hidden');
      expect(u).toContain('bucket%5Bin%5D=a%2Cb');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'f1', name: 'filtered-row' }],
          total: 1,
        }),
      };
    }) as unknown as typeof fetch;

    const filter = encodeURIComponent(
      JSON.stringify({
        score: { gt: 10 },
        title: { neq: 'hidden' },
        bucket: { in: ['a', 'b'] },
      }),
    );
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title?: string }> };
    expect(body.records[0]?.title).toBe('filtered-row');
  });

  // ADR 0019 decision 6: the bracket form was never read on a virtual list, so
  // every filter in it was dropped and the upstream answered unfiltered.
  it('reads the bracket form and refuses what it cannot apply', async () => {
    originalFetch = globalThis.fetch;
    let url = '';
    globalThis.fetch = (async (u: string | URL) => {
      url = String(u);
      return { ok: true, status: 200, json: async () => ({ items: [], total: 0 }) };
    }) as unknown as typeof fetch;
    const ok = await app.request(`/api/data/${COLLECTION}?score[gt]=10`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(decodeURIComponent(url)).toContain('score[gt]=10');
    for (const q of ['score[near]=1', 'ghost[eq]=1']) {
      const res = await app.request(`/api/data/${COLLECTION}?${q}`, { headers: { cookie } });
      expect(res.status).toBe(400);
    }
  });

  it('returns 502 when virtual source rejects an unsupported filter operator', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch;

    const filter = encodeURIComponent(JSON.stringify({ title: { starts_with: 'x' } }));
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain('does not support operator "starts_with"');
  });
});
