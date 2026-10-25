/**
 * An extension's `sensitiveResources` stay sensitive for as long as its data
 * stays, and no longer.
 *
 * A soft uninstall (`POST /api/marketplace/<name>/uninstall`) keeps the
 * extension's tables, data and files and sets `is_installed = false`. The
 * names it asked to keep closed used to be read only for installed extensions,
 * so after the next restart they were ordinary again while its tables still
 * held the data: the boot reconcile handed `tenant_member` and `tenant_viewer`
 * their default access to them. A purge is the point the data goes, and the
 * registration was per process and only grew, so nothing forgot them there.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { syncWithRegistry } from '../../lib/extensions/lifecycle.js';
import {
  forgetSensitiveResources,
  isSensitiveResource,
  registerSensitiveResources,
} from '../../lib/tenancy/permissions.js';
import { reconcileDefaultGrants } from '../../lib/tenancy/resource-grants.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
/** Soft-uninstalled: its collection survives the restart. */
const EXT_SOFT = `sensdata-soft-${STAMP}`;
const COLL_SOFT = `sensdata_soft_${STAMP}`;
/** Purged on another replica: this one hears it through the registry sync. */
const EXT_GONE = `sensdata-gone-${STAMP}`;
const RES_GONE = `sensdata_gone_${STAMP}`;

d('sensitiveResources follow the extension data', () => {
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

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-sensdata-'));
    mkdirSync(join(extRoot, EXT_SOFT), { recursive: true });
    writeFileSync(
      join(extRoot, EXT_SOFT, 'manifest.json'),
      JSON.stringify({ name: EXT_SOFT, resources: [], sensitiveResources: [COLL_SOFT] }),
    );
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;
  }, 60_000);

  afterAll(async () => {
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT_SOFT}, ${EXT_GONE})`.execute(
      db,
    );
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${COLL_SOFT}, ${RES_GONE})`.execute(db);
    await dropTestCollection(db, COLL_SOFT).catch(() => {});
  });

  it('a soft-uninstalled extension keeps its collection closed across a restart', async () => {
    // Its collection, withheld while it was installed, and the soft uninstall's
    // row. This process never loaded it: it is the boot after the uninstall.
    await DDLManager.createCollection(db, {
      name: COLL_SOFT,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${COLL_SOFT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT_SOFT}, ${EXT_SOFT}, NULL, false, false)
    `.execute(db);

    await reconcileDefaultGrants(db, extRoot);

    expect(await grants(COLL_SOFT)).toEqual([]);
    expect(isSensitiveResource(COLL_SOFT)).toBe(true);
  });

  it('a purge is forgotten once the registry has no row for it', async () => {
    // Loaded here; the purge on another replica deleted its row and announced it.
    registerSensitiveResources(EXT_GONE, [RES_GONE]);
    expect(isSensitiveResource(RES_GONE)).toBe(true);

    // The announcement's handler, on a replica that did not load it.
    const loader = { ctx: { db }, isActive: () => false };
    await syncWithRegistry(loader as never, EXT_GONE, async () => {});

    expect(isSensitiveResource(RES_GONE)).toBe(false);
  });

  it("an extension's registration replaces its last one, and leaves the others", async () => {
    const a = `sensdata-a-${STAMP}`;
    const b = `sensdata-b-${STAMP}`;
    registerSensitiveResources(a, ['sensdata_old', 'sensdata_both']);
    registerSensitiveResources(b, ['sensdata_both']);
    // Its next version drops a name.
    registerSensitiveResources(a, ['sensdata_new']);
    expect(isSensitiveResource('sensdata_old')).toBe(false);
    expect(isSensitiveResource('sensdata_new')).toBe(true);
    forgetSensitiveResources(a);
    expect(isSensitiveResource('sensdata_new')).toBe(false);
    // Another extension still declares it.
    expect(isSensitiveResource('sensdata_both')).toBe(true);
    forgetSensitiveResources(b);
    // A core name is never an extension's to forget.
    forgetSensitiveResources('payroll');
    expect(isSensitiveResource('payroll')).toBe(true);
  });
});
