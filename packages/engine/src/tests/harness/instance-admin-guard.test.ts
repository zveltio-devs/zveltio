/**
 * requireInstanceAdmin — the instance-level admin gate that closes the
 * tenant-owner → instance-admin escalation.
 *
 * The `tenant_owner` Casbin policy is `('*','*','*')` within a tenant domain, so
 * `checkPermission(uid, 'admin', '*')` returns TRUE for a delegated tenant owner
 * inside their own domain — which used to be the ONLY gate on the global-pool SQL
 * editor, code deploy, role grants, etc. `requireInstanceAdmin` must refuse a
 * tenant-scoped admin (non-root domain, non-god) while still letting the root
 * admin and god through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import {
  checkPermission,
  getEnforcer,
  requireInstanceAdmin,
  runWithDomain,
} from '../../lib/tenancy/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_DOMAIN = '00000000-0000-4000-8000-0000000000aa';

d('requireInstanceAdmin (in-process)', () => {
  let db: Database;
  const ownerId = crypto.randomUUID();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // A plain (non-god) user who is the OWNER of a delegated tenant.
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${ownerId}, 'Tenant Owner', ${`owner-${ownerId}@test.local`}, false, 'member', now(), now())
    `.execute(db);
    const e = await getEnforcer();
    await e.addRoleForUser(ownerId, 'tenant_owner', TENANT_DOMAIN);
  });

  afterAll(async () => {
    await sql`DELETE FROM "user" WHERE id = ${ownerId}`.execute(db).catch(() => {});
  });

  it('a tenant owner DOES pass checkPermission(admin) in their domain (the gap)', async () => {
    await runWithDomain(TENANT_DOMAIN, async () => {
      expect(await checkPermission(ownerId, 'admin', '*')).toBe(true);
    });
  });

  it('but requireInstanceAdmin REFUSES that tenant owner (escalation closed)', async () => {
    await runWithDomain(TENANT_DOMAIN, async () => {
      expect(await requireInstanceAdmin(ownerId)).toBe(false);
    });
  });

  it('requireInstanceAdmin still refuses the tenant owner even in the root domain', async () => {
    // In the root domain they hold no admin grant at all → false.
    await runWithDomain(DEFAULT_TENANT_ID, async () => {
      expect(await requireInstanceAdmin(ownerId)).toBe(false);
    });
  });

  it('a god user passes requireInstanceAdmin from inside a tenant domain', async () => {
    const godId = crypto.randomUUID();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${godId}, 'God', ${`god-${godId}@test.local`}, false, 'god', now(), now())
    `.execute(db);
    try {
      await runWithDomain(TENANT_DOMAIN, async () => {
        expect(await requireInstanceAdmin(godId)).toBe(true);
      });
    } finally {
      await sql`DELETE FROM "user" WHERE id = ${godId}`.execute(db).catch(() => {});
    }
  });
});
