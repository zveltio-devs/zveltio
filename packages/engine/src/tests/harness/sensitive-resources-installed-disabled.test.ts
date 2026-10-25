/**
 * An installed extension's `sensitiveResources` are withheld from the default
 * grants whether or not it is enabled.
 *
 * They used to be registered only as the extension loaded. A disabled one never
 * loads, yet the boot reconcile and `DDLManager.createCollection` read every
 * installed extension's manifest from disk and granted on what it declares — so
 * the names it asked to keep closed got `tenant_member` and `tenant_viewer`
 * access on every boot. Each extension and name below is used once: the
 * registration is per process and outlives these tests.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { reconcileDefaultGrants, recordManifest } from '../../lib/tenancy/resource-grants.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
/** Boot reconcile: a declared resource, and a collection the action is gated on. */
const EXT_A = `sensdis-a-${STAMP}`;
const RES_A = `sensdis_res_${STAMP}`;
const COLL_A = `sensdis_a_${STAMP}`;
/** createCollection: a collection the action is gated on, created after install. */
const EXT_B = `sensdis-b-${STAMP}`;
const COLL_B = `sensdis_b_${STAMP}`;

const manifest = (name: string, resources: string[], coll: string) => ({
  name,
  resources,
  sensitiveResources: [...resources, coll],
  actions: [
    { name: 'go', permission: { resource: coll }, input: { type: 'object' }, writes: [coll] },
  ],
});

d('sensitiveResources of an installed, disabled extension', () => {
  let db: Database;
  let extRoot: string;
  let savedDir: string | undefined;

  const grants = async (resource: string) =>
    (
      await sql<{ g: string }>`
        SELECT v0 || ':' || v3 AS g FROM zvd_permissions
        WHERE ptype = 'p' AND v1 = '*' AND v2 = ${resource} ORDER BY 1
      `.execute(db)
    ).rows.map((r) => r.g);
  const create = (name: string) =>
    DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  const installDisabled = async (name: string) => {
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${name}, ${name}, NULL, true, false)
    `.execute(db);
    // As the install route does: the claim is read from the row.
    await recordManifest(db, name, join(extRoot, name));
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-sensdis-'));
    for (const [name, m] of [
      [EXT_A, manifest(EXT_A, [RES_A], COLL_A)],
      [EXT_B, manifest(EXT_B, [], COLL_B)],
    ] as const) {
      mkdirSync(join(extRoot, name), { recursive: true });
      writeFileSync(join(extRoot, name, 'manifest.json'), JSON.stringify(m));
    }
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;
  }, 60_000);

  afterAll(async () => {
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT_A}, ${EXT_B})`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${RES_A}, ${COLL_A}, ${COLL_B})`.execute(db);
    await dropTestCollection(db, COLL_A).catch(() => {});
    await dropTestCollection(db, COLL_B).catch(() => {});
  });

  it('the boot reconcile grants no default on them, and keeps an operator grant', async () => {
    // Created before the extension is installed, as an ordinary collection; its
    // defaults are cleared the way a fresh install never wrote them.
    await create(COLL_A);
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${COLL_A}`.execute(db);
    await installDisabled(EXT_A);
    // An operator granted it by name: only defaults are withheld.
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
      VALUES ('p', 'hr_lead', '*', ${RES_A}, 'read')
    `.execute(db);

    await reconcileDefaultGrants(db, extRoot);

    expect(await grants(RES_A)).toEqual(['hr_lead:read']);
    expect(await grants(COLL_A)).toEqual([]);
  });

  it('createCollection grants no default on a collection one of them names', async () => {
    await installDisabled(EXT_B);
    await create(COLL_B);
    expect(await grants(COLL_B)).toEqual([]);
  });
});
