/**
 * Phase C — virtual collection proxy errors (handlers/single.ts + list.ts).
 *
 * Stubs fetch so external API failures surface as 502 through the HTTP handlers.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvirt_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-api',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.items',
  id_field: 'id',
};

d('data virtual collection (in-process)', () => {
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

  it('returns 502 when virtual list fetch fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'upstream down',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });

  it('returns 502 when virtual get-one fetch fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000001`, {
      headers: { cookie },
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when virtual create fetch fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => 'rejected',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'new' }),
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when virtual PUT fetch fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, _init?: RequestInit) => ({
      ok: false,
      status: 500,
      text: async () => 'put failed',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000099`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'replace' }),
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when virtual PATCH fetch fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'patch failed',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000099`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'patch' }),
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when virtual DELETE fetch fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 500, text: async () => 'delete failed' };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000099`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(502);
  });

  it('returns 404 when virtual get-one upstream has no record', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      text: async () => 'missing',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000088`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('proxies virtual list with filter + sort when upstream succeeds', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      expect(u).toContain('title=filtered');
      expect(u).toContain('sort=');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'ext-1', title: 'filtered' }],
          total: 1,
        }),
      };
    }) as unknown as typeof fetch;

    const filter = encodeURIComponent(JSON.stringify({ title: { eq: 'filtered' } }));
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}&sort=title&order=asc`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title?: string }> };
    expect(body.records[0]?.title).toBe('filtered');
  });

  it('proxies virtual get-one when upstream succeeds', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'ext-2', title: 'one-row' }),
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000077`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record?: { title?: string } };
    expect(body.record?.title).toBe('one-row');
  });

  it('proxies virtual create when upstream succeeds', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'ext-new', title: 'created-remote' }),
      };
    }) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'created-remote' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record?: { title?: string } };
    expect(body.record?.title).toBe('created-remote');
  });
});
