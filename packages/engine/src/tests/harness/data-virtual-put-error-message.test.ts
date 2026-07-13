/**
 * Phase C — virtual PUT surfaces upstream HTTP error text (handlers/single.ts replaceRecord).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvputerr_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-put-err',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.items',
  id_field: 'id',
};

d('data virtual PUT HTTP error message (in-process)', () => {
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

  it('returns 502 with the upstream error message when virtual PUT fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      text: async () => 'forbidden upstream',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000088`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'replaced' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail?: string; error?: string };
    const msg = body.detail ?? body.error ?? '';
    expect(msg).toContain('Virtual source returned 403');
    expect(msg).toContain('forbidden upstream');
  });
});
