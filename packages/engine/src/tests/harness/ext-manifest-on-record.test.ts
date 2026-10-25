/**
 * What an extension claims is read from the manifest the engine recorded on its
 * registry row, not from its files.
 *
 * Before: every claim reader read manifest.json from disk. With the files gone
 * and the row kept, the claim was unknown and every reader failed closed for
 * good: no collection could be created or dropped, a purge whose DOWN dropped a
 * collection refused while another such extension had no files (two of them
 * blocked each other), and the sensitive-default repair waited on every boot.
 *
 * And the claim of a soft-uninstalled extension, whose rules stay with its
 * data, did not reserve its names: a collection could be created under one, and
 * another extension's purge dropping a collection of that name took its rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { purgeExtensionData } from '../../lib/extensions/migration-runner.js';
import { forgetSensitiveResources, getEnforcer } from '../../lib/tenancy/permissions.js';
import {
  reconcileDefaultGrants,
  recordManifest,
  registerRegisteredSensitiveResources,
  SENSITIVE_DEFAULTS_REPAIRED,
} from '../../lib/tenancy/resource-grants.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `mrec${Date.now() % 1_000_000}`;
/** Installed; files deleted. */
const A = `${S}a`;
const B = `${S}b`;
/** Soft uninstalled; files deleted. */
const C = `${S}c`;
/** Recorded at one version, then an older one is on disk. */
const V = `${S}v`;
const A_RES = `${S}_ares`;
const A_SENS = `${S}_asens`;
const B_RES = `${S}_bres`;
/** C's resource, never a collection. */
const C_RES = `${S}_cres`;
/** A collection carrying a name C claims; A's DOWN drops it. */
const C_SHARED = `${S}_cshared`;
const A_COLL = `${S}_acoll`;
const B_COLL = `${S}_bcoll`;
const FREE = `${S}_free`;
const COLLECTIONS = [A_COLL, B_COLL, C_SHARED, FREE, C_RES];
const OBJECTS = [`$ext:${A}`, `$ext:${B}`, A_RES, A_SENS, B_RES, C_RES, C_SHARED];

d('an extension whose files are gone keeps its recorded claim', () => {
  let db: Database;
  let extRoot: string;
  let savedDir: string | undefined;

  const rule = (obj: string) => ['tenant_member', '*', obj, 'read'];
  const held = async (obj: string) =>
    (
      await sql`SELECT 1 FROM zvd_permissions
                 WHERE ptype = 'p' AND v0 = 'tenant_member' AND v2 = ${obj} AND v3 = 'read'`.execute(
        db,
      )
    ).rows.length > 0;
  const isCollection = async (name: string) =>
    (await sql`SELECT 1 FROM zvd_collections WHERE name = ${name}`.execute(db)).rows.length > 0;
  const create = (name: string) =>
    DDLManager.createCollection(db, { name, fields: [{ name: 'title', type: 'text' }] } as never);
  const register = (name: string, installed: boolean, manifest: object) => {
    mkdirSync(join(extRoot, name), { recursive: true });
    writeFileSync(join(extRoot, name, 'manifest.json'), JSON.stringify({ name, ...manifest }));
    return sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
               VALUES (${name}, ${name}, NULL, ${installed}, false)`.execute(db);
  };
  const down = (ext: string, tables: string[]) =>
    sql`INSERT INTO zv_migrations (name, down_sql)
        VALUES (${`ext:${ext}:001_init`},
                ${tables.map((t) => `DROP TABLE "zvd_${t}" CASCADE;`).join(' ')})`.execute(db);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-manifest-record-'));
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;
    // Before any extension claims a name.
    for (const name of [A_COLL, B_COLL, C_SHARED]) await create(name);
    await register(A, true, { resources: [A_RES], sensitiveResources: [A_SENS] });
    await register(B, true, { resources: [B_RES] });
    await register(C, false, { resources: [C_RES, C_SHARED] });
    await down(A, [A_COLL, C_SHARED]);
    await down(B, [B_COLL]);
    const e = await getEnforcer();
    for (const obj of [`$ext:${A}`, `$ext:${B}`, A_RES, B_RES, C_SHARED]) {
      await e.addPolicy(...rule(obj));
    }
    // What a boot does first (loadAll, the reconcile): the files are still there.
    await registerRegisteredSensitiveResources(db, extRoot);
    // Then they go; the rows stay.
    for (const name of [A, B, C]) rmSync(join(extRoot, name), { recursive: true, force: true });
  }, 60_000);

  afterAll(async () => {
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${A}, ${B}, ${C}, ${V})`.execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${S}%`}`.execute(db);
    for (const name of [A, B, C]) forgetSensitiveResources(name);
    for (const name of COLLECTIONS) await dropTestCollection(db, name).catch(() => {});
    const e = await getEnforcer();
    for (const obj of OBJECTS) await e.removeFilteredPolicy(2, obj);
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${sql.join(OBJECTS)})`.execute(db);
    await sql`INSERT INTO zv_settings (key, value) VALUES (${SENSITIVE_DEFAULTS_REPAIRED}, 'true'::jsonb)
              ON CONFLICT (key) DO NOTHING`.execute(db);
  });

  it('a collection is created and dropped', async () => {
    await create(FREE);
    expect(await isCollection(FREE)).toBe(true);
    await DDLManager.dropCollection(db, FREE);
    expect(await isCollection(FREE)).toBe(false);
  });

  it('a name an installed or soft-uninstalled extension claims stays reserved', async () => {
    await expect(create(A_RES)).rejects.toThrow(/reserved/);
    await expect(create(C_RES)).rejects.toThrow(/reserved/);
    expect(await isCollection(C_RES)).toBe(false);
  });

  it('the sensitive-default repair runs', async () => {
    await sql`DELETE FROM zv_settings WHERE key = ${SENSITIVE_DEFAULTS_REPAIRED}`.execute(db);
    await (await getEnforcer()).addPolicy(...rule(A_SENS));
    await reconcileDefaultGrants(db, extRoot);
    expect(await held(A_SENS)).toBe(false);
    expect(
      (await sql`SELECT 1 FROM zv_settings WHERE key = ${SENSITIVE_DEFAULTS_REPAIRED}`.execute(db))
        .rows,
    ).toHaveLength(1);
  });

  it('both are purged, each taking its own claimed rules and nothing C claims', async () => {
    await purgeExtensionData(A, db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${A}`.execute(db);
    expect(await isCollection(A_COLL)).toBe(false);
    expect(await isCollection(C_SHARED)).toBe(false);
    expect(await held(`$ext:${A}`)).toBe(false);
    // Known from the record, not the files: A's v1 resource goes with it.
    expect(await held(A_RES)).toBe(false);
    // A soft-uninstalled extension's claim survives a drop of that name.
    expect(await held(C_SHARED)).toBe(true);
    expect(await held(B_RES)).toBe(true);

    await purgeExtensionData(B, db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${B}`.execute(db);
    expect(await isCollection(B_COLL)).toBe(false);
    expect(await held(`$ext:${B}`)).toBe(false);
    expect(await held(B_RES)).toBe(false);
  });

  it('an older manifest on disk does not replace a newer one on record', async () => {
    const at = async (version: string) => {
      mkdirSync(join(extRoot, V), { recursive: true });
      writeFileSync(join(extRoot, V, 'manifest.json'), JSON.stringify({ name: V, version }));
      return recordManifest(db, V, join(extRoot, V));
    };
    const recorded = async () =>
      (
        await sql<{ v: string }>`SELECT manifest->>'version' AS v FROM zv_extension_registry
                                  WHERE name = ${V} AND tenant_id IS NULL`.execute(db)
      ).rows[0]?.v;
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed)
              VALUES (${V}, ${V}, true)`.execute(db);
    expect(await at('2.0.0')).toBe(true);
    // A replica whose disk is behind another's update.
    expect(await at('1.9.0')).toBe(false);
    expect(await recorded()).toBe('2.0.0');
    expect(await at('2.1.0')).toBe(true);
    expect(await recorded()).toBe('2.1.0');
  });
});
