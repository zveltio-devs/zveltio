/**
 * Default grants written on sensitive names before those names were known at
 * grant time are removed once, at boot.
 *
 * An installed but disabled extension's `sensitiveResources` used to be
 * registered only as it loaded, so the boot reconcile wrote `tenant_member` /
 * `tenant_viewer` defaults on them. Registering them first stopped new rows;
 * the ones already written stayed, and a member kept reading what the
 * extension asked to keep closed. `reconcileDefaultGrants` now deletes the
 * default-shaped rows on every sensitive name, once per database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  clearLocalPermissionCache,
  getEnforcer,
} from '../../lib/tenancy/index.js';
import { reconcileDefaultGrants } from '../../lib/tenancy/resource-grants.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const STAMP = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const EXT = `sensrep-${STAMP}`;
const EXT_NO_FILES = `sensrep-nofiles-${STAMP}`;
/** Sensitive in the disabled extension's manifest. */
const SECRET = `sensrep_secret_${STAMP}`;
/** Not sensitive, and nothing re-grants it: a default the repair must leave. */
const PLAIN = `sensrep_plain_${STAMP}`;
const MEMBER = `sensrep-member-${STAMP}`;
/** `SENSITIVE_DEFAULTS_REPAIRED`, spelled out so the test also runs where it is absent. */
const MARKER = 'repair:sensitive_default_grants';

d('repair of default grants on sensitive names', () => {
  let db: Database;
  let extRoot: string;

  const rows = async (resource: string) =>
    (
      await sql<{ g: string }>`
        SELECT v0 || ':' || v3 AS g FROM zvd_permissions
        WHERE ptype = 'p' AND v1 = '*' AND v2 = ${resource} ORDER BY 1
      `.execute(db)
    ).rows.map((r) => r.g);
  /** A row as an older boot wrote it, loaded into the model as boot loads it. */
  const plant = async (role: string, resource: string, action: string) => {
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
              VALUES ('p', ${role}, '*', ${resource}, ${action})
              ON CONFLICT DO NOTHING`.execute(db);
    (await getEnforcer()).getModel().addPolicy('p', 'p', [role, '*', resource, action]);
    clearLocalPermissionCache();
  };
  const memberReads = (resource: string) =>
    runWithDomain(TENANT, () => checkPermission(MEMBER, resource, 'read'));
  const marker = async () =>
    (await sql`SELECT 1 FROM zv_settings WHERE key = ${MARKER}`.execute(db)).rows.length > 0;
  /** Another suite's leftover registry row must not hold the repair back. */
  const stubOtherManifests = async () => {
    const { rows: names } = await sql<{ name: string }>`
      SELECT DISTINCT name FROM zv_extension_registry`.execute(db);
    for (const { name } of names) {
      if (name === EXT || name === EXT_NO_FILES) continue;
      mkdirSync(join(extRoot, name), { recursive: true });
      writeFileSync(join(extRoot, name, 'manifest.json'), '{}');
    }
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-sensrep-'));
    mkdirSync(join(extRoot, EXT), { recursive: true });
    writeFileSync(
      join(extRoot, EXT, 'manifest.json'),
      JSON.stringify({ name: EXT, resources: [SECRET], sensitiveResources: [SECRET] }),
    );
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, NULL, true, false), (${EXT_NO_FILES}, ${EXT_NO_FILES}, NULL, true, false)
    `.execute(db);
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${MEMBER}, ${MEMBER}, ${`${MEMBER}@test.local`}, false, 'member', NOW(), NOW())
    `.execute(db);
    await (await getEnforcer()).addRoleForUser(MEMBER, 'tenant_member', TENANT);
    await sql`DELETE FROM zv_settings WHERE key = ${MARKER}`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${EXT_NO_FILES})`.execute(
      db,
    );
    await sql`DELETE FROM zvd_permissions
              WHERE v2 IN (${SECRET}, ${PLAIN}) OR v0 = ${MEMBER}`.execute(db);
    await (await getEnforcer()).deleteRolesForUser(MEMBER, TENANT);
    await sql`DELETE FROM "user" WHERE id = ${MEMBER}`.execute(db);
    clearLocalPermissionCache();
  });

  it('removes the leaked defaults once, and only on sensitive names', async () => {
    // What a boot before the fix left: defaults on the disabled extension's
    // sensitive name and on a core one, next to ordinary ones.
    await plant('tenant_member', SECRET, 'read');
    await plant('tenant_member', SECRET, 'execute');
    await plant('tenant_viewer', SECRET, 'read');
    await plant('tenant_viewer', 'payroll', 'read');
    await plant('tenant_member', PLAIN, 'read');
    // An operator's grant by another role is not default-shaped.
    await plant('hr_lead', SECRET, 'read');
    expect(await memberReads(SECRET)).toBe(true);

    // An extension with a registry row and no manifest: its names are unknown,
    // so the repair waits instead of spending itself on a partial set.
    await stubOtherManifests();
    await reconcileDefaultGrants(db, extRoot);
    expect(await marker()).toBe(false);
    expect(await rows(SECRET)).toContain('tenant_member:read');

    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT_NO_FILES}`.execute(db);
    await reconcileDefaultGrants(db, extRoot);

    expect(await rows(SECRET)).toEqual(['hr_lead:read']);
    expect(await marker()).toBe(true);
    expect(await rows('payroll')).not.toContain('tenant_viewer:read');
    expect(await rows(PLAIN)).toContain('tenant_member:read');
    // The model was told, not only the table.
    expect(await (await getEnforcer()).hasPolicy('tenant_member', '*', SECRET, 'read')).toBe(false);
    expect(await memberReads(SECRET)).toBe(false);
    expect(await memberReads(PLAIN)).toBe(true);

    // An operator grants it by name afterwards: the next boot keeps it.
    await plant('tenant_member', SECRET, 'read');
    await reconcileDefaultGrants(db, extRoot);
    expect(await rows(SECRET)).toEqual(['hr_lead:read', 'tenant_member:read']);
    expect(await memberReads(SECRET)).toBe(true);
  });
});
