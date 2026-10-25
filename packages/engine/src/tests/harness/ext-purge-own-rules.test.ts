/**
 * Purging an extension removes the rules on its own objects (extension model
 * v3): `$ext:<name>` and its v1 `resources`/`sensitiveResources` that no
 * collection carries and no other extension with data left declares (installed
 * or soft uninstalled). A collection's rules stay, an action-gated collection's
 * `execute` included: the collection's drop takes them.
 *
 * Before: those rules outlived the purge. And an installed extension with no
 * manifest on disk could not be purged once its DOWN dropped a collection: the
 * drop refused the unreadable manifest of the very extension that was leaving.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { purgeExtensionData } from '../../lib/extensions/migration-runner.js';
import { getEnforcer } from '../../lib/tenancy/permissions.js';
import { syncManifestsFromDisk } from '../../lib/tenancy/resource-grants.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `pown${Date.now() % 1_000_000}`;
/** Purged with its manifest. */
const X = `${S}x`;
/** Installed, declares names X declares too. */
const Y = `${S}y`;
/** Installed, purged without a manifest. */
const Z = `${S}z`;
/** Installed without a manifest while X is purged. */
const W = `${S}w`;
/** Soft uninstalled (data and files kept), declares names X declares too. */
const V = `${S}v`;

const X_DROPPED = `${S}_xitems`;
const Z_DROPPED = `${S}_zitems`;
/** Collection X's action is gated on. */
const GATED = `${S}_gated`;
/** Collection carrying the name of one of X's resources. */
const AS_COLLECTION = `${S}_ascol`;
const ONLY = `${S}_only`;
const SENS = `${S}_sens`;
const SHARED_RES = `${S}_shres`;
const SHARED_SENS = `${S}_shsens`;
const SHARED_ACT = `${S}_shact`;
const SOFT_RES = `${S}_sfres`;
const SOFT_SENS = `${S}_sfsens`;
const SOFT_ACT = `${S}_sfact`;
const COLLECTIONS = [X_DROPPED, Z_DROPPED, GATED, AS_COLLECTION];
const OBJECTS = [
  `$ext:${X}`,
  `$ext:${Z}`,
  ...COLLECTIONS,
  ONLY,
  SENS,
  SHARED_RES,
  SHARED_SENS,
  SHARED_ACT,
  SOFT_RES,
  SOFT_SENS,
  SOFT_ACT,
];

d('purging an extension removes the rules on its own objects', () => {
  let db: Database;
  let extRoot: string;
  let savedDir: string | undefined;

  const rule = (obj: string, act = 'read') => ['tenant_member', '*', obj, act];
  const held = async (obj: string, act = 'read') =>
    Number(
      (
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM zvd_permissions
          WHERE ptype = 'p' AND v0 = 'tenant_member' AND v1 = '*' AND v2 = ${obj} AND v3 = ${act}`.execute(
          db,
        )
      ).rows[0]!.n,
    ) > 0;
  const revoked = async (obj: string) =>
    Number(
      (
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM zv_default_grant_revocations
          WHERE resource = ${obj}`.execute(db)
      ).rows[0]!.n,
    ) > 0;
  const inModel = async (obj: string, act = 'read') =>
    (await getEnforcer()).getModel().hasPolicy('p', 'p', rule(obj, act));
  const install = (name: string, installed = true) =>
    sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${name}, ${name}, NULL, ${installed}, ${installed})`.execute(db);
  const down = (ext: string, table: string) =>
    sql`INSERT INTO zv_migrations (name, down_sql)
        VALUES (${`ext:${ext}:001_init`}, ${`DROP TABLE "zvd_${table}" CASCADE`})`.execute(db);
  const writeManifest = (name: string, manifest: object) => {
    mkdirSync(join(extRoot, name), { recursive: true });
    writeFileSync(join(extRoot, name, 'manifest.json'), JSON.stringify({ name, ...manifest }));
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-purge-own-'));
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;
    // Before any extension declares a name: a declared name is refused as a collection.
    for (const name of COLLECTIONS) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text' }],
      } as never);
    }
    writeManifest(X, {
      resources: [ONLY, AS_COLLECTION, SHARED_RES, SHARED_SENS, SHARED_ACT, SOFT_RES, SOFT_ACT],
      sensitiveResources: [SENS, SOFT_SENS],
      actions: [{ name: 'go', permission: { resource: GATED }, input: { type: 'object' } }],
    });
    writeManifest(Y, {
      resources: [SHARED_RES],
      sensitiveResources: [SHARED_SENS],
      actions: [{ name: 'act', permission: { resource: SHARED_ACT }, input: { type: 'object' } }],
    });
    writeManifest(V, {
      resources: [SOFT_RES],
      sensitiveResources: [SOFT_SENS],
      actions: [{ name: 'act', permission: { resource: SOFT_ACT }, input: { type: 'object' } }],
    });
    for (const name of [X, Y]) await install(name);
    await install(V, false);
    // As a boot does: each manifest on disk is recorded on its row.
    await syncManifestsFromDisk(db, extRoot);
    await down(X, X_DROPPED);
    await down(Z, Z_DROPPED);

    const e = await getEnforcer();
    for (const obj of [
      `$ext:${X}`,
      `$ext:${Z}`,
      ONLY,
      SENS,
      SHARED_RES,
      SHARED_SENS,
      SHARED_ACT,
      SOFT_RES,
      SOFT_SENS,
      SOFT_ACT,
    ]) {
      await e.addPolicy(...rule(obj));
    }
    await e.addPolicy(...rule(AS_COLLECTION));
    await e.addPolicy(...rule(GATED, 'execute'));
    for (const obj of [`$ext:${X}`, ONLY, SHARED_RES, AS_COLLECTION]) {
      await sql`INSERT INTO zv_default_grant_revocations (role, resource, action)
                VALUES ('tenant_viewer', ${obj}, 'read') ON CONFLICT DO NOTHING`.execute(db);
    }
  }, 60_000);

  afterAll(async () => {
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${X}, ${Y}, ${Z}, ${W}, ${V})`.execute(
      db,
    );
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${S}%`}`.execute(db);
    for (const name of COLLECTIONS) await dropTestCollection(db, name).catch(() => {});
    const e = await getEnforcer();
    for (const obj of OBJECTS) await e.removeFilteredPolicy(2, obj);
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${sql.join(OBJECTS)})`.execute(db);
    await sql`DELETE FROM zv_default_grant_revocations
              WHERE resource IN (${sql.join(OBJECTS)})`.execute(db);
  });

  it('an installed extension without a manifest is purged; its $ext rule goes', async () => {
    await install(Z);
    await purgeExtensionData(Z, db);
    // As the uninstall route does after the purge.
    await sql`DELETE FROM zv_extension_registry WHERE name = ${Z}`.execute(db);
    expect(
      (await sql`SELECT 1 FROM zvd_collections WHERE name = ${Z_DROPPED}`.execute(db)).rows,
    ).toEqual([]);
    expect(await held(`$ext:${Z}`)).toBe(false);
    expect(await inModel(`$ext:${Z}`)).toBe(false);
    // Others' objects untouched.
    expect(await held(`$ext:${X}`)).toBe(true);
    expect(await held(ONLY)).toBe(true);
  });

  it("another installed extension's unknown claim still fails the purge closed", async () => {
    await install(W);
    try {
      await expect(purgeExtensionData(X, db)).rejects.toThrow(/no manifest on record/);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${W}`.execute(db);
    }
    expect(await held(`$ext:${X}`)).toBe(true);
    expect(await held(ONLY)).toBe(true);
    expect(
      (await sql`SELECT 1 FROM zvd_collections WHERE name = ${X_DROPPED}`.execute(db)).rows,
    ).toHaveLength(1);
  });

  it("a soft-uninstalled extension's unknown claim fails the purge closed too", async () => {
    await install(W, false);
    try {
      await expect(purgeExtensionData(X, db)).rejects.toThrow(/no manifest on record/);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${W}`.execute(db);
    }
    expect(await held(`$ext:${X}`)).toBe(true);
    expect(await held(SOFT_RES)).toBe(true);
  });

  it("removes $ext:X and X-only resource rules; keeps shared names and collections' rules", async () => {
    await purgeExtensionData(X, db);
    for (const obj of [`$ext:${X}`, ONLY, SENS]) {
      expect([obj, await held(obj)]).toEqual([obj, false]);
      expect([obj, await inModel(obj)]).toEqual([obj, false]);
    }
    expect(await revoked(`$ext:${X}`)).toBe(false);
    expect(await revoked(ONLY)).toBe(false);
    // A soft-uninstalled extension's data, and so its claim on its names, stay.
    for (const obj of [
      SHARED_RES,
      SHARED_SENS,
      SHARED_ACT,
      AS_COLLECTION,
      SOFT_RES,
      SOFT_SENS,
      SOFT_ACT,
    ]) {
      expect([obj, await held(obj)]).toEqual([obj, true]);
      expect([obj, await inModel(obj)]).toEqual([obj, true]);
    }
    expect(await revoked(SHARED_RES)).toBe(true);
    expect(await revoked(AS_COLLECTION)).toBe(true);
    expect(await held(GATED, 'execute')).toBe(true);
    expect(await inModel(GATED, 'execute')).toBe(true);
  });
});
