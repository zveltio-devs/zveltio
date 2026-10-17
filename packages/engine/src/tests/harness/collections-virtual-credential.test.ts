/**
 * routes/collections.ts — a virtual collection's upstream credential
 * (`virtual_config.auth_value`) is write-only: neither collection GET serves it,
 * nor the schema export that `schema pull` and the dev writer put in `schema/`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvcred_${Date.now()}`;
const SECRET = 'upstream-secret-token';
// Stored as a jsonb string, the shape a `JSON.stringify` writer left (010).
const LEGACY = `hvcredl_${Date.now()}`;
const LEGACY_SECRET = 'legacy-upstream-secret';

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
    await db
      .insertInto('zvd_collections')
      .values({
        name: LEGACY,
        display_name: LEGACY,
        icon: 'Table',
        route_group: 'private',
        is_permissioned: true,
        is_managed: true,
        is_system: false,
        schema_locked: false,
        sort: 99,
        singular_name: LEGACY,
        source_type: 'virtual',
        virtual_config: sql`to_jsonb(${JSON.stringify({
          source_url: 'https://example.com/api',
          auth_type: 'bearer',
          auth_value: LEGACY_SECRET,
          id_field: 'id',
        })}::text)` as never,
        fields: toJsonb([{ name: 'title', type: 'text' }]),
      })
      .execute();
    DDLManager.invalidateCache(COLLECTION);
    DDLManager.invalidateCache(LEGACY);
  });

  afterAll(async () => {
    if (!db) return;
    await db.deleteFrom('zvd_collections').where('name', 'in', [COLLECTION, LEGACY]).execute();
    DDLManager.invalidateCache(COLLECTION);
    DDLManager.invalidateCache(LEGACY);
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
    expect(text).toContain(LEGACY);
    expect(text).not.toContain(LEGACY_SECRET);
  });

  it('a config stored as a jsonb string loses auth_value too', async () => {
    const res = await app.request(`/api/collections/${LEGACY}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(LEGACY_SECRET);
    const body = JSON.parse(text) as { collection: { virtual_config: Record<string, unknown> } };
    expect(body.collection.virtual_config.auth_type).toBe('bearer');
  });

  it('GET /api/admin/collections (permissions matrix) does not serve auth_value', async () => {
    const res = await app.request('/api/admin/collections', { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(COLLECTION);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(LEGACY_SECRET);
  });

  it('GET /api/admin/schema/export keeps the config but not auth_value', async () => {
    const res = await app.request('/api/admin/schema/export', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { files } = (await res.json()) as { files: Record<string, string> };
    const file = files[`collections/${COLLECTION}.json`];
    expect(JSON.parse(file).virtualConfig.auth_type).toBe('bearer');
    expect(file).not.toContain(SECRET);
    const legacy = files[`collections/${LEGACY}.json`];
    expect(JSON.parse(legacy).virtualConfig.auth_type).toBe('bearer');
    expect(legacy).not.toContain(LEGACY_SECRET);
  });
});
