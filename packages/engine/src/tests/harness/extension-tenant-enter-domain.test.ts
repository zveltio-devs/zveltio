/**
 * An extension holding `tenant:enter` that enters another tenant acts AS that
 * tenant inside it.
 *
 * `withTenantIsolation` opens the transaction for the tenant it is given, but a
 * nested call keeps the enclosing domain — the request's. So inside the entered
 * tenant's transaction, permission checks and the identity helpers
 * (`addTenantMember`, `listTenantUsers`, …) answered for the request's tenant
 * while the rows went to the entered one. SCIM, whose bearer token names the
 * tenant, enters it from a request that may already run as another.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import {
  DEFAULT_TENANT_ID,
  getCurrentDomainOrNull,
  runWithDomain,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`.slice(-12).padStart(12, '0');
const T = `00000000-0000-0000-0e17-${TAG}`;

d('ctx.internals.withTenantIsolation with tenant:enter', () => {
  let db: Database;
  const entering = gateInternals('auth/scim', buildExtensionInternals(), ['tenant:enter']);
  const bare = gateInternals('auth/scim', buildExtensionInternals(), []);

  const inside = async (internals: typeof entering, tenant: string) =>
    internals.withTenantIsolation(tenant, async (trx) => ({
      domain: getCurrentDomainOrNull(),
      guc: (
        await sql<{
          t: string;
        }>`SELECT current_setting('zveltio.current_tenant', true) AS t`.execute(trx)
      ).rows[0]?.t,
    }));

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T}::uuid, ${`enter-${TAG}`}, 'enter', 'active')`.execute(db);
  });

  afterAll(async () => {
    if (db) await sql`DELETE FROM zv_tenants WHERE id = ${T}::uuid`.execute(db);
  });

  it('entered from a request running as another tenant, the work runs as the entered one', async () => {
    const seen = await runWithDomain(DEFAULT_TENANT_ID, () => inside(entering, T));
    expect(seen).toEqual({ domain: T, guc: T });
  });

  it('entered from no tenant at all, the same', async () => {
    expect(await inside(entering, T)).toEqual({ domain: T, guc: T });
  });

  it('the running tenant itself needs no capability and keeps its domain', async () => {
    const seen = await runWithDomain(T, () => inside(bare, T));
    expect(seen).toEqual({ domain: T, guc: T });
  });

  it('another tenant without tenant:enter is still refused', async () => {
    await expect(runWithDomain(DEFAULT_TENANT_ID, () => inside(bare, T))).rejects.toThrow(
      /tenant:enter/,
    );
  });
});
