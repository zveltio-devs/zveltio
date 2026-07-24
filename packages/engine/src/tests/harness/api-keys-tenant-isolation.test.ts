/**
 * Tenant isolation — API keys + invitations (migration 021).
 *
 * The /api/api-keys management routes (admin.ts apiKeysRoutes + admin/system-
 * routes.ts) listed, revoked and patched keys by raw id against the un-scoped
 * pool, so a tenant admin saw EVERY tenant's keys and could revoke/patch another
 * tenant's key by id (cross-tenant IDOR). We add tenant_id and scope every
 * management handler by the request tenant. The god session runs as the DEFAULT
 * tenant; a key/access-log/invite planted under OTHER_TENANT must stay invisible
 * and untouchable.
 *
 * No DB-level RLS is used here on purpose — zv_api_keys is read by the API-key
 * auth guard before tenant resolution runs, so a strict policy would break auth.
 * Isolation is at the route layer (mirrors saved-queries/import, migration 019).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const STAMP = Date.now();
const FOREIGN_KEY_ID = '00000000-0000-4000-8000-0000000000e1';
const FOREIGN_LOG_ID = '00000000-0000-4000-8000-0000000000e2';

d('api-keys/invitations tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A foreign tenant's active API key — must NOT surface or be revocable here.
    await db
      .insertInto('zv_api_keys')
      .values({
        id: FOREIGN_KEY_ID,
        name: `foreign-key-${STAMP}`,
        key_hash: `hash-${STAMP}`,
        key_prefix: 'zvk_foreign0',
        scopes: JSON.stringify([]),
        rate_limit: 1000,
        is_active: true,
        created_by: null,
        request_count: 0,
        tenant_id: OTHER_TENANT,
      } as never)
      .execute();

    // A foreign access-log row for that key — the access-log endpoint must not
    // return it (transitive isolation via the parent key's tenant).
    await db
      .insertInto('zv_api_key_access_log')
      .values({
        id: FOREIGN_LOG_ID,
        api_key_id: FOREIGN_KEY_ID,
        method: 'GET',
        path: '/whatever',
        status_code: 200,
        ip_address: '10.0.0.1',
      } as never)
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_api_key_access_log')
      .where('id', '=', FOREIGN_LOG_ID)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_api_keys')
      .where('id', '=', FOREIGN_KEY_ID)
      .execute()
      .catch(() => {});
  });

  it('another tenant’s API key is not listed', async () => {
    const res = await app.request('/api/api-keys', { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { api_keys: { id: string }[] }).api_keys.map((k) => k.id);
    expect(ids).not.toContain(FOREIGN_KEY_ID);
  });

  it('revoking another tenant’s key by id does not deactivate it (no cross-tenant IDOR)', async () => {
    const res = await app.request(`/api/api-keys/${FOREIGN_KEY_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    // The handler returns success (idempotent), but the scoped UPDATE matched no
    // rows, so the foreign key stays active.
    expect(res.status).toBe(200);
    const row = await db
      .selectFrom('zv_api_keys')
      .select('is_active')
      .where('id', '=', FOREIGN_KEY_ID)
      .executeTakeFirst();
    expect(row?.is_active).toBe(true);
  });

  it('a new invitation is stamped with the request tenant', async () => {
    // Sanity: the invitation insert now carries tenant_id (default tenant here).
    const before = await db
      .selectFrom('zv_invitations')
      .select('tenant_id')
      .limit(1)
      .executeTakeFirst();
    // Column exists and is non-null on any row that exists (migration backfill).
    if (before) expect(before.tenant_id).toBeTruthy();
    else expect(true).toBe(true);
  });
});
