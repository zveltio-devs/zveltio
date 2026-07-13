/**
 * Phase C — column permissions apply to VIRTUAL collections too. Regression:
 * getRecord/listRecords virtual branches proxied the external record verbatim,
 * skipping applyColumnAccess, so a column the role can't read leaked through the
 * proxy.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvcol_${Date.now()}`;

const VIRTUAL_CONFIG = {
  source_url: 'https://example.com/virtual-api',
  auth_type: 'none',
  field_mapping: {},
  list_path: '$.items',
  id_field: 'id',
};

d('virtual collection column access (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let originalFetch: typeof fetch;
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
        can_read: false,
        can_write: true,
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

  it('single virtual GET hides the unreadable column', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'ext-1', title: 'visible', secret: 'leaked' }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}/00000000-0000-4000-8000-000000000001`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(body.record.title).toBe('visible');
    expect('secret' in body.record).toBe(false);
  });

  it('virtual list hides the unreadable column', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: 'ext-1', title: 'visible', secret: 'leaked' }],
        total: 1,
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    expect(body.records[0]?.title).toBe('visible');
    expect('secret' in (body.records[0] ?? {})).toBe(false);
  });
});
