/**
 * Purging an extension removes the rules on its own object, `$ext:<name>`, and
 * the collections it dropped take theirs (ADR 0002). A rule names an existing
 * object (migration 116), so there is nothing else to attribute: another
 * extension's claim, known or not, no longer decides what a purge takes. A
 * collection's rules stay, an action-gated collection's `execute` included:
 * the collection's drop takes them.
 *
 * Before: those rules outlived the purge. And an installed extension with no
 * manifest on disk could not be purged once its DOWN dropped a collection: the
 * drop refused the unreadable manifest of the very extension that was leaving.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { purgeExtensionData } from '../../lib/extensions/migration-runner.js';
import { getEnforcer } from '../../lib/tenancy/permissions.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `pown${Date.now() % 1_000_000}`;
/** Purged; installed with no manifest on record. */
const X = `${S}x`;
/** Purged first, the same way. */
const Z = `${S}z`;
/** Installed, no manifest on record, while X is purged. */
const W = `${S}w`;

const X_DROPPED = `${S}_xitems`;
const Z_DROPPED = `${S}_zitems`;
/** Collection X's action is gated on; not X's. */
const GATED = `${S}_gated`;
const KEPT = `${S}_kept`;
const COLLECTIONS = [X_DROPPED, Z_DROPPED, GATED, KEPT];
const OBJECTS = [`$ext:${X}`, `$ext:${Z}`, ...COLLECTIONS];

d('purging an extension removes the rules on its own object', () => {
  let db: Database;

  const rule = (obj: string, act = 'read') => ['tenant_member', '*', obj, act];
  const held = async (obj: string, act = 'read') =>
    (
      await sql`SELECT 1 FROM zvd_permissions
        WHERE ptype = 'p' AND v0 = 'tenant_member' AND v1 = '*' AND v2 = ${obj} AND v3 = ${act}`.execute(
        db,
      )
    ).rows.length > 0;
  const revoked = async (obj: string) =>
    (await sql`SELECT 1 FROM zv_default_grant_revocations WHERE resource = ${obj}`.execute(db)).rows
      .length > 0;
  const inModel = async (obj: string, act = 'read') =>
    (await getEnforcer()).getModel().hasPolicy('p', 'p', rule(obj, act));
  const install = (name: string) =>
    sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
  const down = (ext: string, table: string) =>
    sql`INSERT INTO zv_migrations (name, down_sql)
        VALUES (${`ext:${ext}:001_init`}, ${`DROP TABLE "zvd_${table}" CASCADE`})`.execute(db);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const name of COLLECTIONS) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text' }],
      } as never);
    }
    for (const name of [X, Z]) await install(name);
    await down(X, X_DROPPED);
    await down(Z, Z_DROPPED);

    const e = await getEnforcer();
    for (const obj of [`$ext:${X}`, `$ext:${Z}`, X_DROPPED, Z_DROPPED, KEPT]) {
      await e.addPolicy(...rule(obj));
    }
    await e.addPolicy(...rule(GATED, 'execute'));
    for (const obj of [`$ext:${X}`, X_DROPPED, KEPT]) {
      await sql`INSERT INTO zv_default_grant_revocations (role, resource, action)
                VALUES ('tenant_viewer', ${obj}, 'read') ON CONFLICT DO NOTHING`.execute(db);
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${X}, ${Z}, ${W})`.execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${S}%`}`.execute(db);
    for (const name of COLLECTIONS) await dropTestCollection(db, name).catch(() => {});
    const e = await getEnforcer();
    for (const obj of OBJECTS) await e.removeFilteredPolicy(2, obj);
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${sql.join(OBJECTS)})`.execute(db);
    await sql`DELETE FROM zv_default_grant_revocations
              WHERE resource IN (${sql.join(OBJECTS)})`.execute(db);
  });

  it('an installed extension without a manifest is purged; its $ext rule goes', async () => {
    await purgeExtensionData(Z, db);
    // As the uninstall route does after the purge.
    await sql`DELETE FROM zv_extension_registry WHERE name = ${Z}`.execute(db);
    expect(
      (await sql`SELECT 1 FROM zvd_collections WHERE name = ${Z_DROPPED}`.execute(db)).rows,
    ).toEqual([]);
    for (const obj of [`$ext:${Z}`, Z_DROPPED]) {
      expect([obj, await held(obj)]).toEqual([obj, false]);
      expect([obj, await inModel(obj)]).toEqual([obj, false]);
    }
    // Others' objects untouched.
    expect(await held(`$ext:${X}`)).toBe(true);
    expect(await held(KEPT)).toBe(true);
  });

  it("removes $ext:X and its dropped collection's rules, whatever another extension's claim; keeps every other collection's", async () => {
    // Unknown, and no longer asked: a rule names an existing object, so a
    // purge has nothing to attribute.
    await install(W);
    await purgeExtensionData(X, db);
    for (const obj of [`$ext:${X}`, X_DROPPED]) {
      expect([obj, await held(obj)]).toEqual([obj, false]);
      expect([obj, await inModel(obj)]).toEqual([obj, false]);
      expect([obj, await revoked(obj)]).toEqual([obj, false]);
    }
    expect(await held(KEPT)).toBe(true);
    expect(await inModel(KEPT)).toBe(true);
    expect(await revoked(KEPT)).toBe(true);
    expect(await held(GATED, 'execute')).toBe(true);
    expect(await inModel(GATED, 'execute')).toBe(true);
  });
});
