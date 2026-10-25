/**
 * Only an install makes an extension installed.
 *
 * Before: `PUT /api/marketplace/:name/config` and `POST /:name/disable` upserted
 * a registry row with `is_installed = true` for any name, one never installed
 * included. That row has no manifest on disk, so every collection create and
 * drop failed closed (`nonCollectionObjects`), and so did every other
 * extension's purge, until someone purged the phantom.
 *
 * And a purge of an extension whose own manifest cannot be read takes only
 * `$ext:<name>`, which no other extension can claim: another unreadable
 * manifest no longer refuses it. Two of them each refused the other's purge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { purgeExtensionData } from '../../lib/extensions/migration-runner.js';
import { nonCollectionObjects } from '../../lib/tenancy/resource-grants.js';
import { getEnforcer } from '../../lib/tenancy/permissions.js';
import { createSteppedUpGod, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `phan${Date.now() % 1_000_000}`;
/** Never installed. */
const GHOST = `${S}-ghost`;
/** Installed, no manifest on disk. */
const P = `${S}-p`;
const Q = `${S}-q`;
const NAMES = [GHOST, P, Q];

d('a registry row without an install', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let extRoot: string;
  let savedDir: string | undefined;

  const row = async (name: string) =>
    (await sql`SELECT is_installed FROM zv_extension_registry WHERE name = ${name}`.execute(db))
      .rows;
  const held = async (obj: string) =>
    (
      await sql`SELECT 1 FROM zvd_permissions
                 WHERE ptype = 'p' AND v0 = 'tenant_member' AND v2 = ${obj}`.execute(db)
    ).rows.length > 0;

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ cookie, app } = await createSteppedUpGod(t.app, db));
    extRoot = mkdtempSync(join(tmpdir(), 'ext-phantom-'));
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;
  }, 60_000);

  afterAll(async () => {
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${sql.join(NAMES)})`.execute(db);
    const objects = NAMES.map((n) => `$ext:${n}`);
    const e = await getEnforcer();
    for (const obj of objects) await e.removeFilteredPolicy(2, obj);
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${sql.join(objects)})`.execute(db);
  });

  it('config on a name never installed is 404 and writes no row', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ k: 'v' }),
    });
    expect(res.status).toBe(404);
    expect(await row(GHOST)).toEqual([]);
    // What the phantom broke: every collection create and drop.
    await expect(nonCollectionObjects(db)).resolves.toBeInstanceOf(Set);
  });

  it('disable on a name never installed is a no-op and writes no row', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await row(GHOST)).toEqual([]);
  });

  it('config on an installed extension is stored', async () => {
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${P}, ${P}, true, false)`.execute(db);
    try {
      const res = await app.request(`/api/marketplace/${P}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ k: 'v' }),
      });
      expect(res.status).toBe(200);
      const { rows } = await sql<{ config: unknown }>`
        SELECT config FROM zv_extension_registry WHERE name = ${P}`.execute(db);
      expect(rows[0]?.config).toEqual({ k: 'v' });
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${P}`.execute(db);
    }
  });

  it('two installed extensions without manifests can each be purged', async () => {
    for (const n of [P, Q]) {
      await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
                VALUES (${n}, ${n}, true, false)`.execute(db);
      await (await getEnforcer()).addPolicy('tenant_member', '*', `$ext:${n}`, 'read');
    }
    await purgeExtensionData(P, db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${P}`.execute(db);
    expect(await held(`$ext:${P}`)).toBe(false);
    expect(await held(`$ext:${Q}`)).toBe(true);
    await purgeExtensionData(Q, db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${Q}`.execute(db);
    expect(await held(`$ext:${Q}`)).toBe(false);
  });
});
