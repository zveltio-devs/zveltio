/**
 * ADR 0012: an extension declares its collections as schema files; the engine
 * creates them, on god's enable, and records itself as their owner.
 *
 * The fixture extension declares `decl_tasks` in `manifest.collections` with
 * `schema/collections/decl_tasks.json`. A firm's activate before god's enable is
 * refused (pending schema is a pending migration) and creates nothing; god's
 * enable creates the collection with `owner_extension`, the data API serves it
 * through its default grants, the instance export leaves it out, a later version
 * adds a field, a removed field is refused, and a declared name that an
 * unowned collection already holds refuses the whole set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { applySchema } from '../../lib/schema-artifact/apply.js';
import { exportSchema } from '../../lib/schema-artifact/export.js';
import {
  createMemberSession,
  createSteppedUpGod,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// In the bundled catalog as first-party, so it may load inline and god may enable it.
const NAME = 'hello-ext';
const TASKS = 'decl_tasks';
const NOTES = 'decl_notes';
const CLASH = 'decl_clash';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const text = (name: string) => ({ name, type: 'text' });

d('an extension declares its collections; the engine creates and owns them', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };

  /** Writes the package: the manifest's `collections` and one schema file per collection. */
  const ship = async (collections: Record<string, { name: string; type: string }[]>) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    manifest.collections = Object.keys(collections);
    await Bun.write(join(base, NAME, 'manifest.json'), JSON.stringify(manifest));
    rmSync(join(base, NAME, 'schema'), { recursive: true, force: true });
    for (const [name, fields] of Object.entries(collections)) {
      await Bun.write(
        join(base, NAME, `schema/collections/${name}.json`),
        JSON.stringify({ name, fields }),
      );
    }
  };
  const owner = async (name: string) =>
    (
      await sql<{
        owner_extension: string | null;
      }>`SELECT owner_extension FROM zvd_collections WHERE name = ${name}`.execute(db)
    ).rows[0];
  const fields = async (name: string) =>
    ((await DDLManager.getCollection(db, name))?.fields as { name: string }[] | undefined)?.map(
      (f) => f.name,
    );
  /** God installed it and never enabled it; `before` runs while no row claims anything. */
  const reset = async (before?: () => Promise<void>) => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    for (const c of [TASKS, NOTES, CLASH]) await dropTestCollection(db, c);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await before?.();
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
  };
  const post = (action: string) =>
    engine.request(`/api/marketplace/${NAME}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: '{}',
    });
  const lastLoadError = async () =>
    (
      await sql<{ e: string | null }>`SELECT last_load_error AS e FROM zv_extension_registry
                                       WHERE name = ${NAME} AND tenant_id IS NULL`.execute(db)
    ).rows[0]?.e;

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-declcol-'));
    process.env.EXTENSIONS_DIR = base;
    _resetCatalogCacheForTests();
    await Bun.write(
      join(base, NAME, 'engine/index.js'),
      `export default { name: ${JSON.stringify(NAME)}, category: 'fixture', async register() {} };`,
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
      for (const c of [TASKS, NOTES, CLASH]) await dropTestCollection(db, c);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("a firm's activate is refused while the declared schema is pending", async () => {
    await reset();
    await ship({ [TASKS]: [text('title')] });
    const r = await post('activate');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { detail: string }).detail).toMatch(/not applied yet/);
    expect(await owner(TASKS)).toBeUndefined();
    expect(await DDLManager.tableExists(db, TASKS)).toBe(false);
  }, 30_000);

  it("god's enable creates it, owned, and the data API serves it", async () => {
    await reset();
    await ship({ [TASKS]: [text('title')] });
    expect((await post('enable')).status).toBe(200);
    expect(await owner(TASKS)).toEqual({ owner_extension: NAME });
    expect(await DDLManager.tableExists(db, TASKS)).toBe(true);

    // The default grants every created collection gets, and a member's rows through them.
    const defaults = await sql<{ v0: string; v3: string }>`
      SELECT v0, v3 FROM zvd_permissions WHERE ptype = 'p' AND v2 = ${TASKS} ORDER BY v0, v3`.execute(
      db,
    );
    expect(defaults.rows.filter((r) => r.v0 === 'tenant_member').map((r) => r.v3)).toEqual([
      'create',
      'read',
      'update',
    ]);
    const { cookie } = await createMemberSession(engine, db, {
      grants: [{ collection: TASKS, actions: ['read', 'create'] }],
    });
    const created = await engine.request(`/api/data/${TASKS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'first' }),
    });
    expect(created.status).toBe(201);
    const read = await engine.request(`/api/data/${TASKS}`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain('"first"');

    // The package holds it, not the instance artifact.
    expect(Object.keys(await exportSchema(db))).not.toContain(`collections/${TASKS}.json`);
    expect(Object.keys(await exportSchema(db, { owner: NAME }))).toEqual(
      expect.arrayContaining([`collections/${TASKS}.json`]),
    );

    // Nor are the instance's files the ones to drop it.
    const id = '20261029T000000-drop-tasks';
    const drop = {
      ...(await exportSchema(db)),
      [`migrations/${id}.json`]: JSON.stringify({
        id,
        ops: [{ op: 'dropCollection', collection: TASKS }],
      }),
    };
    await expect(applySchema(db, drop, undefined, { allowDestructive: true })).rejects.toThrow(
      /engine or extension collection/,
    );
    expect(await DDLManager.tableExists(db, TASKS)).toBe(true);

    // Applied, nothing is owed: a firm's activate loads it.
    expect((await post('disable')).status).toBe(200);
    expect((await post('activate')).status).toBe(200);
    expect(extensionLoader.isActive(NAME)).toBe(true);
  }, 60_000);

  it('a later version adds a field; a removed field is refused and changes nothing', async () => {
    await reset();
    await ship({ [TASKS]: [text('title')] });
    expect((await post('enable')).status).toBe(200);
    await extensionLoader.unload(NAME);

    await ship({ [TASKS]: [text('title'), text('due')] });
    expect((await post('enable')).status).toBe(200);
    expect(await fields(TASKS)).toEqual(['title', 'due']);
    await extensionLoader.unload(NAME);

    await ship({ [TASKS]: [text('title')] });
    expect((await post('enable')).status).toBe(422);
    expect(await lastLoadError()).toMatch(/drop field due/);
    expect(await fields(TASKS)).toEqual(['title', 'due']);
  }, 60_000);

  it('a declared name an unowned collection holds refuses the whole set', async () => {
    await reset(() =>
      DDLManager.createCollection(db, { name: CLASH, fields: [text('x')] } as never),
    );
    await ship({ [NOTES]: [text('body')], [CLASH]: [text('x')] });
    expect((await post('enable')).status).toBe(422);
    expect(await lastLoadError()).toMatch(
      /decl_clash exists and extension "hello-ext" does not own/,
    );
    expect(await owner(CLASH)).toEqual({ owner_extension: null });
    expect(await owner(NOTES)).toBeUndefined();
    expect(await DDLManager.tableExists(db, NOTES)).toBe(false);
  }, 60_000);
});
