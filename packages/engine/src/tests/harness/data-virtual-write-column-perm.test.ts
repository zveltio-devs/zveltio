/**
 * Phase C — virtual collection WRITES must enforce column-level write permission
 * like regular writes. Regression: virtual create/PUT/PATCH sent the raw body to
 * the external API without filterWritableFields, so a role denied write on a
 * column could still push it upstream.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvwr_${Date.now()}`;
const ID = '00000000-0000-4000-8000-000000000042';

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-api',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.items',
  id_field: 'id',
};

d('virtual collection write column permission (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let originalFetch: typeof fetch;
  let fetchCalled = false;
  let colPermId = '';

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
          { name: 'secret', type: 'text', required: false, unique: false, indexed: false },
        ]),
      })
      .execute();
    DDLManager.invalidateCache(COLLECTION);

    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'secret',
        role: '*',
        can_read: true,
        can_write: false,
      })
      .returning('id')
      .executeTakeFirst();
    colPermId = perm?.id ?? '';
    await invalidateColumnPermCache(COLLECTION);
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    if (!db) return;
    if (colPermId) {
      await db
        .deleteFrom('zvd_column_permissions')
        .where('id', '=', colPermId)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    DDLManager.invalidateCache(COLLECTION);
  });

  const stubFetch = () => {
    originalFetch = globalThis.fetch;
    fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({ id: ID }), text: async () => '' };
    }) as unknown as typeof fetch;
  };

  it('virtual POST rejects a write-denied column with 403 and never calls upstream', async () => {
    stubFetch();
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'ok', secret: 'nope' }),
    });
    expect(res.status).toBe(403);
    expect(fetchCalled).toBe(false);
  });

  it('virtual PUT rejects a write-denied column with 403', async () => {
    stubFetch();
    const res = await app.request(`/api/data/${COLLECTION}/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'ok', secret: 'nope' }),
    });
    expect(res.status).toBe(403);
    expect(fetchCalled).toBe(false);
  });

  it('virtual write allowed when only writable columns are sent', async () => {
    stubFetch();
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'ok' }),
    });
    expect(res.status).toBe(201);
    expect(fetchCalled).toBe(true);
  });
});
