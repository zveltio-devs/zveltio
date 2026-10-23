/**
 * A newer version on disk replaces the copy a firm's row keeps loaded.
 *
 * With god's row off and a firm's on, version N stays loaded (#1281). God puts
 * N+1 on disk and enables it: the enable saw the extension active and answered
 * success without loading anything, so N's code kept running and N+1's
 * migrations waited for the next boot. Every other replica returned early from
 * its sync for the same reason (active, and wanted active), and an install of
 * N+1 announced nothing at all.
 *
 * And under all of them Bun's import() caches by path: a load of N+1 from the
 * path N was imported from handed back N's module, so even a reload ran the old
 * code and the old migration list.
 *
 * Now the enable, the sync and the install reload a copy whose version is not
 * the one on disk, from a fresh path when the bytes changed. On the sync and the
 * install the load is the firm's alone, so N+1's pending migrations refuse it,
 * as boot does: god's enable runs them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { dispatchToWs, EXTENSION_LIFECYCLE_EVENT, engineEvents } from '../../lib/runtime/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { createSteppedUpGod, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// In the bundled catalog as first-party, so it may load inline and god may enable it.
const NAME = 'hello-ext';
const T1 = 'zv_hello_ext_upg_one';
const T2 = 'zv_hello_ext_upg_two';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');

d('a newer version on disk replaces the copy a firm keeps loaded', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = {
    extDir: process.env.EXTENSIONS_DIR,
    devReload: process.env.ZVELTIO_EXTENSION_DEV_RELOAD,
    ctx: extensionLoader.ctx,
  };

  const tableExists = async (t: string) =>
    (await sql<{ t: string | null }>`SELECT to_regclass(${t})::text AS t`.execute(db)).rows[0]?.t !=
    null;
  const lastLoadError = async () =>
    (
      await sql<{ e: string | null }>`SELECT last_load_error AS e FROM zv_extension_registry
                                       WHERE name = ${NAME} AND tenant_id IS NULL`.execute(db)
    ).rows[0]?.e;
  const post = (action: string) =>
    engine.request(`/api/marketplace/${NAME}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: '{}',
    });

  /** Version `version` on disk, at the same path every time, declaring `tables`' migrations. */
  const putOnDisk = async (version: string, tables: string[]) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    manifest.version = version;
    const dir = join(base, NAME);
    rmSync(dir, { recursive: true, force: true });
    await Bun.write(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const files = tables.map((t, i) => `migrations/00${i + 1}_${t}.sql`);
    for (const [i, t] of tables.entries()) {
      await Bun.write(
        join(dir, 'engine', files[i] as string),
        `CREATE TABLE ${t} (id int);\n-- DOWN\nDROP TABLE IF EXISTS ${t};\n`,
      );
    }
    await Bun.write(
      join(dir, 'engine/index.js'),
      `import { join } from 'node:path';
       export default {
         name: ${JSON.stringify(NAME)},
         category: 'fixture',
         getMigrations: () => ${JSON.stringify(files)}.map((f) => join(import.meta.dir, f)),
         async register() {},
       };`,
    );
  };

  /** Version 1.0.0 loaded for the firm alone: god enabled it once (its migration ran), then turned his row off. */
  const firmRunsV1 = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    for (const t of [T1, T2]) await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
    await putOnDisk('1.0.0', [T1]);
    expect((await post('enable')).status).toBe(200);
    expect((await post('disable')).status).toBe(200);
    expect((await post('activate')).status).toBe(200);
    expect(extensionLoader.loaded.get(NAME)?.version).toBe('1.0.0');
    expect(await tableExists(T1)).toBe(true);
    // God puts 1.1.0 on disk: one more migration.
    await putOnDisk('1.1.0', [T1, T2]);
  };

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-upgrade-'));
    process.env.EXTENSIONS_DIR = base;
    // The production import path: no dev-reload copy to hide Bun's cache.
    delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
    _resetCatalogCacheForTests();
    extensionLoader.ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    extensionLoader.setReloadCallback(async () => {});
  }, 60_000);

  afterAll(async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    extensionLoader.ctx = saved.ctx;
    if (saved.extDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = saved.extDir;
    if (saved.devReload !== undefined) process.env.ZVELTIO_EXTENSION_DEV_RELOAD = saved.devReload;
    if (db) {
      for (const t of [T1, T2]) await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("god's enable loads the new version and runs its migrations", async () => {
    await firmRunsV1();
    expect((await post('enable')).status).toBe(200);
    expect(extensionLoader.loaded.get(NAME)?.version).toBe('1.1.0');
    expect(await tableExists(T2)).toBe(true);
  }, 60_000);

  it("another replica's sync does not keep the old one; the firm's load refuses as boot does", async () => {
    await firmRunsV1();
    await dispatchToWs({
      originId: 'replica-a',
      event: EXTENSION_LIFECYCLE_EVENT,
      collection: NAME,
      timestamp: new Date().toISOString(),
    });
    expect(extensionLoader.isActive(NAME)).toBe(false);
    expect(await tableExists(T2)).toBe(false);
    expect(await lastLoadError()).toMatch(/not applied yet/);
  }, 60_000);

  it('an install of the new version does the same here', async () => {
    await firmRunsV1();
    expect((await post('install')).status).toBe(200);
    expect(extensionLoader.isActive(NAME)).toBe(false);
    expect(await tableExists(T2)).toBe(false);
    expect(await lastLoadError()).toMatch(/not applied yet/);
  }, 60_000);
});
