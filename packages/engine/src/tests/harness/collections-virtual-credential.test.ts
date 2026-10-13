/**
 * routes/collections.ts — a virtual collection's upstream credential
 * (`virtual_config.auth_value`) is write-only: neither collection GET serves it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvcred_${Date.now()}`;
const SECRET = 'upstream-secret-token';

d('virtual collection credential (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

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
        virtual_config: toJsonb({
          source_url: 'https://example.com/api',
          auth_type: 'bearer',
          auth_value: SECRET,
          field_mapping: {},
          id_field: 'id',
        }),
        fields: toJsonb([{ name: 'title', type: 'text' }]),
      })
      .execute();
    DDLManager.invalidateCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
    DDLManager.invalidateCache(COLLECTION);
  });

  it('GET /api/collections/:name keeps the config but not auth_value', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { collection: { virtual_config: Record<string, unknown> } };
    expect(body.collection.virtual_config.auth_type).toBe('bearer');
  });

  it('GET /api/collections does not serve auth_value either', async () => {
    const res = await app.request('/api/collections', { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(COLLECTION);
    expect(text).not.toContain(SECRET);
  });
});
