/**
 * The boot reconcile grants nothing while an extension with a registry row has
 * no manifest on record: what it keeps closed is unknown.
 *
 * Before: it still granted the defaults on every collection, a name that
 * extension declared sensitive included. On a settled install the one-time
 * repair of such defaults has already run, so once the manifest was back the
 * grant stayed for good.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  forgetSensitiveResources,
  getEnforcer,
  isSensitiveResource,
} from '../../lib/tenancy/permissions.js';
import {
  reconcileDefaultGrants,
  SENSITIVE_DEFAULTS_REPAIRED,
} from '../../lib/tenancy/resource-grants.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `unkc${Date.now() % 1_000_000}`;
const EXT = `${S}ext`;
/** A collection EXT's manifest declares sensitive. */
const SECRET = `${S}_secret`;
/** An ordinary collection. */
const PLAIN = `${S}_plain`;

d('boot reconcile with an extension whose claim is unknown', () => {
  let db: Database;
  let extRoot: string;

  const held = async (obj: string) =>
    (
      await sql`SELECT 1 FROM zvd_permissions
                 WHERE ptype = 'p' AND v0 = 'tenant_member' AND v2 = ${obj} AND v3 = 'read'`.execute(
        db,
      )
    ).rows.length > 0;
  /** Its rules gone without a revocation on record, as on a collection the defaults never reached. */
  const strip = async (obj: string) => {
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${obj}`.execute(db);
    (await getEnforcer()).getModel().removeFilteredPolicy('p', 'p', 2, obj);
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-unknown-claim-'));
    // Another suite's leftover registry row must not be the unknown claim here.
    const { rows } = await sql<{ name: string }>`
      SELECT DISTINCT name FROM zv_extension_registry`.execute(db);
    for (const { name } of rows) {
      mkdirSync(join(extRoot, name), { recursive: true });
      writeFileSync(join(extRoot, name, 'manifest.json'), '{}');
    }
    for (const name of [SECRET, PLAIN]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text' }],
      } as never);
      await strip(name);
    }
    // A settled install: the one-time repair has run.
    await sql`INSERT INTO zv_settings (key, value) VALUES (${SENSITIVE_DEFAULTS_REPAIRED}, 'true'::jsonb)
              ON CONFLICT (key) DO NOTHING`.execute(db);
    // Installed, no manifest on record, none on disk.
    await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, NULL, true, false)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    forgetSensitiveResources(EXT);
    for (const name of [SECRET, PLAIN]) {
      await dropTestCollection(db, name).catch(() => {});
      await strip(name);
    }
  });

  it('grants nothing while the claim is unknown', async () => {
    await reconcileDefaultGrants(db, extRoot);
    expect(await held(SECRET)).toBe(false);
    expect(await held(PLAIN)).toBe(false);
  });

  it('grants the ordinary collection, and not the sensitive one, once the manifest is back', async () => {
    mkdirSync(join(extRoot, EXT), { recursive: true });
    writeFileSync(
      join(extRoot, EXT, 'manifest.json'),
      JSON.stringify({ name: EXT, sensitiveResources: [SECRET] }),
    );
    await reconcileDefaultGrants(db, extRoot);
    expect(isSensitiveResource(SECRET)).toBe(true);
    expect(await held(SECRET)).toBe(false);
    expect(await held(PLAIN)).toBe(true);
  });
});
