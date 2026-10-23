/**
 * An extension's migrations run on god's decision only (owner, 2026-10-23).
 *
 * A migration is instance-level DDL, run as the database owner. Since #1281 an
 * extension's code loads while ANY registry row has it on, and loading runs its
 * pending migrations: so a firm admin's activate of an extension god installed
 * but never enabled ran its migrations, and so did boot, another replica's sync
 * and the outage resync on that firm row's behalf. Same for a newer version god
 * installed but has not enabled.
 *
 * Now a load that only a firm's row asks for refuses while migrations are
 * pending (recorded in `last_load_error`), and a firm's activate answers 409
 * and leaves no row behind. God's enable runs them as before; after it a firm's
 * activate loads the extension with nothing left to run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
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
const TABLE = 'zv_hello_ext_pendprobe';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');

d("an extension's migrations run on god's decision only", () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };

  const tableExists = async () =>
    (await sql<{ t: string | null }>`SELECT to_regclass(${TABLE})::text AS t`.execute(db)).rows[0]
      ?.t != null;
  const migrationRows = async () =>
    (
      await sql<{ n: number }>`SELECT count(*)::int AS n FROM zv_migrations
                                WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db)
    ).rows[0]?.n;
  const firmRow = async () =>
    (
      await sql<{ is_enabled: boolean }>`SELECT is_enabled FROM zv_extension_registry
                                          WHERE name = ${NAME} AND tenant_id = ${DEFAULT_TENANT_ID}`.execute(
        db,
      )
    ).rows[0];
  const lastLoadError = async () =>
    (
      await sql<{ e: string | null }>`SELECT last_load_error AS e FROM zv_extension_registry
                                       WHERE name = ${NAME} AND tenant_id IS NULL`.execute(db)
    ).rows[0]?.e;

  /** God installed it and never enabled it: nothing ran, nothing is loaded. */
  const installedOnly = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
  };
  const firmOn = () =>
    sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
        VALUES (${NAME}, ${NAME}, ${DEFAULT_TENANT_ID}, true, true)`.execute(db);
  const post = (action: string) =>
    engine.request(`/api/marketplace/${NAME}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: '{}',
    });

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-pendmig-'));
    process.env.EXTENSIONS_DIR = base;
    _resetCatalogCacheForTests();
    // The fixture's manifest, with an entry that declares one migration.
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    await Bun.write(join(base, NAME, 'manifest.json'), JSON.stringify(manifest));
    await Bun.write(
      join(base, NAME, 'engine/index.js'),
      `import { join } from 'node:path';
       export default {
         name: ${JSON.stringify(NAME)},
         category: 'fixture',
         getMigrations: () => [join(import.meta.dir, 'migrations/001_probe.sql')],
         async register() {},
       };`,
    );
    await Bun.write(
      join(base, NAME, 'engine/migrations/001_probe.sql'),
      `CREATE TABLE ${TABLE} (id int);\n-- DOWN\nDROP TABLE IF EXISTS ${TABLE};\n`,
    );
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
    if (db) {
      await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("a firm's activate is refused while migrations are pending", async () => {
    await installedOnly();
    const r = await post('activate');
    expect(r.status).toBe(409);
    // `{ error }` reaches the client as an RFC 9457 problem's `detail`.
    expect(((await r.json()) as { detail: string }).detail).toMatch(/not applied yet/);
    expect(await tableExists()).toBe(false);
    expect(await migrationRows()).toBe(0);
    expect(await firmRow()).toBeUndefined();
    expect(extensionLoader.isActive(NAME)).toBe(false);
  }, 30_000);

  it("a firm's row does not get it loaded by the sync or the outage resync", async () => {
    await installedOnly();
    await firmOn();
    await dispatchToWs({
      originId: 'replica-a',
      event: EXTENSION_LIFECYCLE_EVENT,
      collection: NAME,
      timestamp: new Date().toISOString(),
    });
    await extensionLoader.syncAllWithRegistry();
    expect(extensionLoader.isActive(NAME)).toBe(false);
    expect(await tableExists()).toBe(false);
    expect(await migrationRows()).toBe(0);
    expect(await lastLoadError()).toMatch(/not applied yet/);
  }, 30_000);

  it("a firm's row does not get it loaded at boot", async () => {
    await installedOnly();
    await firmOn();
    await extensionLoader.loadFromDB(db, new Hono(), []);
    expect(extensionLoader.isActive(NAME)).toBe(false);
    expect(await tableExists()).toBe(false);
    expect(await migrationRows()).toBe(0);
    expect(await lastLoadError()).toMatch(/not applied yet/);
  }, 30_000);

  it("god's enable runs them; a firm's activate then loads with nothing to run", async () => {
    await installedOnly();
    expect((await post('enable')).status).toBe(200);
    expect(await tableExists()).toBe(true);
    expect(await migrationRows()).toBe(1);
    expect((await post('disable')).status).toBe(200);
    expect(extensionLoader.isActive(NAME)).toBe(false);
    const r = await post('activate');
    expect(r.status).toBe(200);
    expect(extensionLoader.isActive(NAME)).toBe(true);
    expect((await firmRow())?.is_enabled).toBe(true);
    expect(await migrationRows()).toBe(1);
  }, 30_000);
});
