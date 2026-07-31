/**
 * An API key may only act in the tenant it belongs to.
 *
 * The lookup in `lib/data/auth.ts` was hash-only: a key issued in tenant A,
 * sent with `X-Tenant-Slug: tenant-b`, authenticated and then read and wrote
 * tenant B's data. Migration 021 added `tenant_id` to `zv_api_keys` exactly so
 * this comparison could exist — and scoped the MANAGEMENT routes with it while
 * leaving the AUTH path, which is the one that decides what a request may touch.
 *
 * Root-tenant keys act anywhere by design: migration 021 backfilled every
 * pre-existing key to root, so a strict match would refuse working keys on
 * upgrade, and a root-tenant key is already an instance-level credential.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { hashApiKey } from '../../lib/security/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const OTHER_TENANT = '00000000-0000-0000-0000-0000000000fe';
const ROOT_TENANT = '00000000-0000-0000-0000-000000000001';
const STAMP = Date.now();
const FOREIGN_KEY = `zvk_foreign_${STAMP}`;
const ROOT_KEY = `zvk_root_${STAMP}`;

d('API keys are bound to their tenant', () => {
  let app: Hono;
  let db: Database;

  const insertKey = async (raw: string, tenantId: string, name: string) => {
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id)
      VALUES (${name}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              '["*"]'::jsonb, true, ${tenantId}::uuid)
    `.execute(db);
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await insertKey(FOREIGN_KEY, OTHER_TENANT, `foreign-${STAMP}`);
    await insertKey(ROOT_KEY, ROOT_TENANT, `root-${STAMP}`);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name IN (${`foreign-${STAMP}`}, ${`root-${STAMP}`})`
      .execute(db)
      .catch(() => {});
  });

  it('refuses a key from another tenant, even though the key itself is valid', async () => {
    // The key exists, is active and unexpired — everything the old lookup
    // checked. What makes it wrong is where it is being used.
    const res = await app.request('/api/data/zvd_accounts', {
      headers: { 'X-API-Key': FOREIGN_KEY },
    });
    expect(res.status).toBe(401);
  });

  it('refuses it on a write too, not only a read', async () => {
    const res = await app.request('/api/data/zvd_accounts', {
      method: 'POST',
      headers: { 'X-API-Key': FOREIGN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'should not land' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('still accepts a root-tenant key', async () => {
    // Whatever this returns, it must not be an auth failure — root keys are
    // instance-scoped on purpose, and breaking them would break every install
    // whose keys migration 021 backfilled to root.
    const res = await app.request('/api/data/zvd_accounts', {
      headers: { 'X-API-Key': ROOT_KEY },
    });
    expect(res.status).not.toBe(401);
  });

  it('rejects an unknown key exactly as before', async () => {
    const res = await app.request('/api/data/zvd_accounts', {
      headers: { 'X-API-Key': `zvk_nonexistent_${STAMP}` },
    });
    expect(res.status).toBe(401);
  });
});
