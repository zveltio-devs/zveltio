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
 *
 * Amendment 1: an operator's structure change on an owned collection answers
 * 409 (point 5), while the row rules and column permissions an operator adds
 * survive the extension's next load, which removes only its own entries; a
 * `defaultGrants: false` file gets no default grant, at enable or at boot (point 2).
 *
 * Amendment 2: an operator adds fields named with `OPERATOR_FIELD_PREFIX` to an
 * owned collection, optional or with a default, and alters and drops them; the
 * extension's next load neither drops nor alters them, and a file that declares
 * one is refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { DDLManager, OPERATOR_FIELD_PREFIX as P } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { readSchemaDir, schemaDigest } from '../../lib/extensions/declared-collections.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { reconcileDefaultGrants, setWithheldCollections } from '../../lib/tenancy/index.js';
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
const PLAIN = 'decl_plain';
const JOBS = 'decl_jobs';
const ALL = [TASKS, NOTES, CLASH, PLAIN, JOBS];
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const text = (name: string) => ({ name, type: 'text' });

d('an extension declares its collections; the engine creates and owns them', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };

  /** Writes the package: the manifest's `collections` and one schema file per collection (its fields, or the file). */
  const ship = async (
    collections: Record<string, { name: string; type: string }[] | Record<string, unknown>>,
  ) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    manifest.collections = Object.keys(collections);
    rmSync(join(base, NAME, 'schema'), { recursive: true, force: true });
    for (const [name, file] of Object.entries(collections)) {
      await Bun.write(
        join(base, NAME, `schema/collections/${name}.json`),
        JSON.stringify(Array.isArray(file) ? { name, fields: file } : { name, ...file }),
      );
    }
    // As `extension pack` writes it.
    manifest.integrity = { schemaSha256: schemaDigest(await readSchemaDir(join(base, NAME))) };
    await Bun.write(join(base, NAME, 'manifest.json'), JSON.stringify(manifest));
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
  /** The fixture collections, with the rules and relations naming them. */
  const forget = async () => {
    await sql`DELETE FROM zvd_relations WHERE source_collection IN (${sql.join(ALL)})`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE collection IN (${sql.join(ALL)})`.execute(db);
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name IN (${sql.join(ALL)})`.execute(
      db,
    );
    for (const c of ALL) await dropTestCollection(db, c);
  };
  /** God installed it and never enabled it; `before` runs while no row claims anything. */
  const reset = async (before?: () => Promise<void>) => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    await forget();
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await before?.();
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
  };
  const call = (method: string, path: string, body?: unknown) =>
    engine.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
      await forget();
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

  it("an operator's structure change on an owned collection answers 409; an unowned one takes it", async () => {
    await reset(() =>
      DDLManager.createCollection(db, { name: PLAIN, fields: [text('x')] } as never),
    );
    await ship({ [TASKS]: [text('title')] });
    expect((await post('enable')).status).toBe(200);

    const refused = async (r: Response) => {
      expect(r.status).toBe(409);
      expect(((await r.json()) as { detail: string }).detail).toMatch(
        /belongs to extension "hello-ext"/,
      );
    };
    await refused(await call('PATCH', `/api/collections/${TASKS}`, { displayName: 'Mine' }));
    // A name without the operator prefix: a 422 that names it (amendment 2).
    const unprefixed = await call('POST', `/api/collections/${TASKS}/fields`, text('extra'));
    expect(unprefixed.status).toBe(422);
    expect(((await unprefixed.json()) as { detail: string }).detail).toMatch(
      /belongs to extension "hello-ext": a field you add to it must start with "my_"/,
    );
    await refused(
      await call('PATCH', `/api/collections/${TASKS}/fields/title`, { required: true }),
    );
    await refused(await call('DELETE', `/api/collections/${TASKS}/fields/title`));
    await refused(await call('POST', `/api/collections/${TASKS}/sync-schema`));
    await refused(await call('DELETE', `/api/collections/${TASKS}`));
    // A relation whose key would sit in the owned table: from it, or an o2m into it.
    const relation = (type: string, source: string, target: string, field: string) =>
      call('POST', '/api/relations', {
        name: `${source}_${field}`,
        type,
        source_collection: source,
        source_field: field,
        target_collection: target,
        ...(type === 'o2m' ? { target_field: `${source}_ref` } : {}),
      });
    await refused(await relation('m2o', TASKS, PLAIN, 'plain_id'));
    await refused(await relation('o2m', PLAIN, TASKS, 'tasks'));
    // The extension's relation (as its own apply would write it) is not the operator's to edit.
    const { id } = await db
      .insertInto('zvd_relations')
      .values({
        name: 'ext_rel',
        type: 'm2o',
        source_collection: TASKS,
        source_field: 'title',
        target_collection: PLAIN,
        target_field: 'id',
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await refused(await call('PATCH', `/api/relations/${id}`, { on_delete: 'CASCADE' }));
    await refused(await call('DELETE', `/api/relations/${id}`));
    await sql`DELETE FROM zvd_relations WHERE id = ${id}`.execute(db);
    // Nor through the instance's schema files, whose plan does not see it.
    const mid = '20261029T000001-rename-title';
    await expect(
      applySchema(
        db,
        {
          ...(await exportSchema(db)),
          [`migrations/${mid}.json`]: JSON.stringify({
            id: mid,
            ops: [{ op: 'renameField', collection: TASKS, from: 'title', to: 'name' }],
          }),
        },
        undefined,
      ),
    ).rejects.toThrow(/names collection decl_tasks, which does not exist/);
    expect(await fields(TASKS)).toEqual(['title']);
    // Nor a schema branch's merge.
    const made = (await (
      await call('POST', '/api/schema/branches', { name: 'declcol' })
    ).json()) as {
      branch: { id: string };
      schema: string;
    };
    try {
      const at = `/api/schema/branches/${made.branch.id}`;
      await call('POST', `${at}/changes`, {
        type: 'remove_field',
        payload: { collection: TASKS, field: 'title' },
      });
      await call('POST', `${at}/changes`, {
        type: 'add_field',
        payload: { collection: TASKS, field: text('extra') },
      });
      const merged = (await (await call('POST', `${at}/merge`)).json()) as { errors: string[] };
      expect(merged.errors.filter((e) => /belongs to extension "hello-ext"/.test(e))).toHaveLength(
        2,
      );
      expect(await fields(TASKS)).toEqual(['title']);
    } finally {
      await sql`DELETE FROM zv_schema_branches WHERE id = ${made.branch.id}`.execute(db);
      await sql`DROP SCHEMA IF EXISTS ${sql.id(made.schema)} CASCADE`.execute(db);
    }

    // The operator's own collection: the same doors are open, and a relation into the owned one.
    expect((await call('PATCH', `/api/collections/${PLAIN}`, { displayName: 'P' })).status).toBe(
      200,
    );
    expect((await call('POST', `/api/collections/${PLAIN}/fields`, text('extra'))).status).toBe(
      200,
    );
    expect((await relation('m2o', PLAIN, TASKS, 'task_id')).status).toBe(201);
  }, 60_000);

  it("an operator's rules survive the extension's next load, which removes only its own", async () => {
    await reset();
    const mine = { role: 'tenant_viewer', column: 'title', read: true, write: false };
    const kept = { role: 'tenant_viewer', column: 'note', read: true, write: false };
    await ship({
      [TASKS]: { fields: [text('title'), text('note')], columnPermissions: [mine, kept] },
    });
    expect((await post('enable')).status).toBe(200);

    // The operator's, through the routes an owned collection still answers.
    const rule = await call('POST', '/api/admin/rls', {
      collection: TASKS,
      role: 'tenant_member',
      filter_field: 'title',
      filter_value_source: 'static:x',
    });
    expect(rule.status).toBe(201);
    const perm = await call('POST', '/api/admin/column-permissions', {
      collection_name: TASKS,
      column_name: 'note',
      role: 'tenant_member',
      can_read: true,
      can_write: false,
    });
    expect(perm.status).toBe(201);
    await extensionLoader.unload(NAME);

    // The next version drops `mine` and keeps `kept`.
    await ship({ [TASKS]: { fields: [text('title'), text('note')], columnPermissions: [kept] } });
    expect((await post('enable')).status).toBe(200);
    const perms = await sql<{ role: string; column_name: string }>`
      SELECT role, column_name FROM zvd_column_permissions
       WHERE collection_name = ${TASKS} ORDER BY role, column_name`.execute(db);
    expect(perms.rows).toEqual([
      { role: 'tenant_member', column_name: 'note' },
      { role: 'tenant_viewer', column_name: 'note' },
    ]);
    const rules = await sql<{ role: string }>`
      SELECT role FROM zvd_rls_policies WHERE collection = ${TASKS}`.execute(db);
    expect(rules.rows).toEqual([{ role: 'tenant_member' }]);

    // Settled: nothing owed, so a firm's activate loads it.
    expect((await post('disable')).status).toBe(200);
    expect((await post('activate')).status).toBe(200);
  }, 60_000);

  it('defaultGrants false: no default grant at enable, nor at the boot reconcile', async () => {
    await reset();
    await ship({
      [TASKS]: [text('title')],
      [JOBS]: { fields: [text('state')], defaultGrants: false },
    });
    expect((await post('enable')).status).toBe(200);
    const defaults = async (name: string) =>
      (
        await sql<{ v0: string }>`SELECT DISTINCT v0 FROM zvd_permissions
                                   WHERE ptype = 'p' AND v1 = '*' AND v2 = ${name} ORDER BY v0`.execute(
          db,
        )
      ).rows.map((r) => r.v0);
    expect(await defaults(JOBS)).toEqual([]);
    expect(await defaults(TASKS)).toEqual(['tenant_member', 'tenant_viewer']);
    // A boot: a new process knows nothing withheld until it reads the table.
    setWithheldCollections([]);
    await reconcileDefaultGrants(db, base);
    expect(await defaults(JOBS)).toEqual([]);
    // Planned again with nothing owed: the file's `false` is what the instance holds.
    expect((await post('disable')).status).toBe(200);
    expect((await post('activate')).status).toBe(200);

    // The instance's files withhold a default with roles.json, not with this.
    const own = {
      ...(await exportSchema(db)),
      [`collections/${NOTES}.json`]: JSON.stringify({
        name: NOTES,
        fields: [text('body')],
        defaultGrants: false,
      }),
    };
    await expect(applySchema(db, own, undefined)).rejects.toThrow(/extension collection's setting/);
    expect(await DDLManager.tableExists(db, NOTES)).toBe(false);
  }, 60_000);
  it("an operator's prefixed fields on an owned collection; the extension's load leaves them", async () => {
    await reset(() =>
      DDLManager.createCollection(db, { name: PLAIN, fields: [text('x')] } as never),
    );
    await ship({ [TASKS]: [text('title')] });
    expect((await post('enable')).status).toBe(200);
    const status = async (r: Response, want: number, detail?: RegExp) => {
      const body = (await r.json()) as { detail?: string };
      expect([r.status, body.detail]).toEqual([
        want,
        detail ? expect.stringMatching(detail) : body.detail,
      ]);
    };
    const add = (field: Record<string, unknown>) =>
      call('POST', `/api/collections/${TASKS}/fields`, field);

    // Prefixed, and optional: the extension's inserts know none of them. A default does
    // not make a required field safe — the data API demands one on every create.
    await status(await add(text('note')), 422, /must start with "my_"/);
    await status(
      await add({ ...text(`${P}req`), required: true, defaultValue: 'n/a' }),
      422,
      /must be optional/,
    );
    await status(await add({ ...text(`${P}req`), defaultValue: 'n/a' }), 200);
    await status(await add(text(`${P}note`)), 200);
    // An m2o is a field on the owned collection; an o2m into it keys the owned table.
    const rel = await call('POST', '/api/relations', {
      name: `${TASKS}_plain`,
      type: 'm2o',
      source_collection: TASKS,
      source_field: `${P}plain_id`,
      target_collection: PLAIN,
    });
    expect(rel.status).toBe(201);
    await status(
      await call('POST', `/api/collections/${PLAIN}/fields`, {
        name: 'tasks',
        type: 'o2m',
        options: { related_collection: TASKS },
      }),
      409,
      /belongs to extension "hello-ext"/,
    );
    expect(await fields(PLAIN)).toEqual(['x']);

    // The operator's own field changes as the operator likes, and stays the operator's.
    const field = (name: string) => `/api/collections/${TASKS}/fields/${name}`;
    await status(await call('PATCH', field(`${P}note`), { required: true }), 422, /optional/);
    await status(await call('PATCH', field(`${P}note`), { new_name: 'memo' }), 422, /"my_"/);
    await status(await call('PATCH', field(`${P}note`), { new_name: `${P}memo` }), 200);
    await status(await call('PATCH', field('title'), { new_name: `${P}title` }), 409);

    // A member's insert, through the handlers the extension's own writes run.
    const { cookie } = await createMemberSession(engine, db, {
      grants: [{ collection: TASKS, actions: ['read', 'create'] }],
    });
    const created = await engine.request(`/api/data/${TASKS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'first' }),
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).toContain(`"${P}req":"n/a"`);
    await extensionLoader.unload(NAME);

    // A new version adds a field, then reorders its own: the operator's stay, after them.
    const mine = [`${P}req`, `${P}memo`, `${P}plain_id`];
    await ship({ [TASKS]: [text('title'), text('due')] });
    expect((await post('enable')).status).toBe(200);
    expect(await fields(TASKS)).toEqual(['title', ...mine, 'due']);
    await extensionLoader.unload(NAME);
    await ship({ [TASKS]: [text('due'), text('title')] });
    expect((await post('enable')).status).toBe(200);
    expect(await fields(TASKS)).toEqual(['due', 'title', ...mine]);
    const relations = await sql<{ n: number }>`SELECT count(*)::int AS n FROM zvd_relations
      WHERE source_collection = ${TASKS} AND source_field = ${`${P}plain_id`}`.execute(db);
    expect(relations.rows[0]?.n).toBe(1);
    // Settled with them in place: nothing owed, so a firm's activate loads it.
    expect((await post('disable')).status).toBe(200);
    expect((await post('activate')).status).toBe(200);

    // The operator drops its own field, through the route and through a branch merge.
    await status(await call('DELETE', field(`${P}memo`)), 200);
    const made = (await (
      await call('POST', '/api/schema/branches', { name: 'declcol2' })
    ).json()) as { branch: { id: string }; schema: string };
    try {
      const at = `/api/schema/branches/${made.branch.id}`;
      await call('POST', `${at}/changes`, {
        type: 'remove_field',
        payload: { collection: TASKS, field: `${P}req` },
      });
      const merged = (await (await call('POST', `${at}/merge`)).json()) as { errors: string[] };
      expect(merged.errors).toEqual([]);
    } finally {
      await sql`DELETE FROM zv_schema_branches WHERE id = ${made.branch.id}`.execute(db);
      await sql`DROP SCHEMA IF EXISTS ${sql.id(made.schema)} CASCADE`.execute(db);
    }
    expect(await fields(TASKS)).toEqual(['due', 'title', `${P}plain_id`]);
    await extensionLoader.unload(NAME);

    // A file that declares an operator's name is refused, and changes nothing.
    await ship({ [TASKS]: [text('due'), text('title'), text(`${P}bad`)] });
    expect((await post('enable')).status).toBe(422);
    expect(await lastLoadError()).toMatch(/my_bad starts with "my_"/);
    expect(await fields(TASKS)).toEqual(['due', 'title', `${P}plain_id`]);
  }, 90_000);
});
