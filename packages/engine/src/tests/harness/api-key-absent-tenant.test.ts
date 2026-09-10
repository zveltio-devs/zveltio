/**
 * A tenant-scoped API key must not act as root when the request resolves no tenant.
 *
 * `validateApiKey` compares the key's tenant to the request's, and that
 * comparison carried a `requestTenantId &&` clause: when the request resolved
 * NO tenant the whole comparison was skipped and the key was accepted. That
 * would be harmless if "no tenant" meant "no access", but it does not. The two
 * places that derive the request's tenant disagreed:
 *
 *   route-db.ts    tenantId(c)  →  DEFAULT_TENANT_ID when nothing resolved
 *   data/auth.ts   requestTenantId →  null            when nothing resolved
 *
 * So a request with no resolved tenant authenticated with an ordinary tenant's
 * key, and then every downstream reader treated it as acting in the root
 * tenant. This is the campaign's "absence of a tenant resolves to root" shape,
 * met here for the fifth time.
 *
 * The fix is in `validateApiKey`, not in its callers: absent is treated as
 * root, which is what the rest of the engine already does with it, so a
 * non-root key is refused exactly as it would be against an explicit root.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { validateApiKey } from '../../lib/data/auth.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { hashApiKey } from '../../lib/security/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const OTHER = '00000000-0000-0000-0000-0000000009a1';

d('an API key cannot reach root by resolving no tenant', () => {
  let db: Database;
  let tenantKeyId = '';
  let rootKeyId = '';
  const tenantRaw = `zvk_${STAMP}_scoped`;
  const rootRaw = `zvk_${STAMP}_root`;

  beforeAll(async () => {
    ({ db } = await getTestApp());

    await sql`
      INSERT INTO zv_tenants (id, slug, name, status)
      VALUES (${OTHER}::uuid, ${`absent-tenant-probe-${STAMP}`}, 'Absent Tenant Probe', 'active')
      ON CONFLICT (id) DO UPDATE SET status = 'active'
    `.execute(db);

    tenantKeyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id)
        VALUES ('scoped probe', ${await hashApiKey(tenantRaw)}, 'zvk_', '[]'::jsonb, 100, true, ${OTHER}::uuid)
        RETURNING id
      `.execute(db)
    ).rows[0]!.id;

    // The control. Root-tenant keys are instance-level credentials by design,
    // and migration 021 backfilled every pre-existing key to root — so if the
    // fix refused these too, it would break working keys on upgrade.
    rootKeyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id)
        VALUES ('root probe', ${await hashApiKey(rootRaw)}, 'zvk_', '[]'::jsonb, 100, true, ${DEFAULT_TENANT_ID}::uuid)
        RETURNING id
      `.execute(db)
    ).rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of [tenantKeyId, rootKeyId]) {
      if (id) await sql`DELETE FROM zv_api_keys WHERE id = ${id}::uuid`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db).catch(() => {});
  });

  it('refuses a tenant-scoped key when the request resolved no tenant', async () => {
    // The defect: `null` skipped the comparison, so this returned the key row.
    expect(await validateApiKey(db, tenantRaw, null)).toBeNull();
  });

  it('refuses a tenant-scoped key against an explicit root tenant', async () => {
    // Same refusal, stated explicitly. The two must agree — that they did not
    // is the whole defect, so asserting only one of them would not hold it.
    expect(await validateApiKey(db, tenantRaw, DEFAULT_TENANT_ID)).toBeNull();
  });

  it('still accepts the key in its own tenant', async () => {
    const row = await validateApiKey(db, tenantRaw, OTHER);
    expect(row?.id).toBe(tenantKeyId);
  });

  it('still accepts a root-tenant key with no resolved tenant', async () => {
    const row = await validateApiKey(db, rootRaw, null);
    expect(row?.id).toBe(rootKeyId);
  });
});
