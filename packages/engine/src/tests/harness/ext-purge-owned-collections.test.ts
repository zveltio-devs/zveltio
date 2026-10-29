/**
 * ADR 0012 amendment 1, point 1: a purge drops every collection the extension
 * owns (`zvd_collections.owner_extension`), with every rule naming it — grants
 * in every domain, revoked defaults, row rules, column permissions, validation,
 * relations and their junctions — and an operator's `my_` fields go with the
 * table. Uninstall without purge keeps all of it. A collection created under
 * the same name afterwards inherits nothing (A13).
 *
 * An operator column that references an owned collection (an m2o into it) is
 * the operator's data in the operator's table: the purge refuses, naming it,
 * and drops nothing, until the operator removes it.
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
import { getEnforcer } from '../../lib/tenancy/index.js';
import {
  createSteppedUpGod,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = 'hello-ext';
const ITEMS = 'po_items';
const TAGS = 'po_tags';
const PLAIN = 'po_plain';
const OWNED = [ITEMS, TAGS];
const ALL = [...OWNED, PLAIN];
const TENANT = '00000000-0000-4000-8000-00000000a13a';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const text = (name: string) => ({ name, type: 'text' });

d('a purge drops the collections the extension owns, with all their rules', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };

  const call = (method: string, path: string, body?: unknown) =>
    engine.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const uninstall = (purge: boolean) =>
    call('POST', `/api/marketplace/${NAME}/uninstall${purge ? '?purgeData=true' : ''}`, {});
  /** Rows naming any of `names`, per table that keeps something under a collection's name. */
  const leftovers = async (names: string[]) => {
    const n = async (q: ReturnType<typeof sql<{ n: number }>>) =>
      (await q.execute(db)).rows[0]?.n ?? 0;
    const list = sql.join(names);
    return {
      collections: await n(sql`SELECT count(*)::int AS n FROM zvd_collections
                                WHERE name IN (${list})`),
      permissions: await n(sql`SELECT count(*)::int AS n FROM zvd_permissions
                                WHERE v2 IN (${list})`),
      revocations: await n(sql`SELECT count(*)::int AS n FROM zv_default_grant_revocations
                                WHERE resource IN (${list})`),
      rowRules: await n(sql`SELECT count(*)::int AS n FROM zvd_rls_policies
                             WHERE collection IN (${list})`),
      columnPermissions: await n(sql`SELECT count(*)::int AS n FROM zvd_column_permissions
                                      WHERE collection_name IN (${list})`),
      validation: await n(sql`SELECT count(*)::int AS n FROM zv_validation_rules
                               WHERE collection IN (${list})`),
      relations: await n(sql`SELECT count(*)::int AS n FROM zvd_relations
                              WHERE source_collection IN (${list}) OR target_collection IN (${list})`),
    };
  };
  const none = {
    collections: 0,
    permissions: 0,
    revocations: 0,
    rowRules: 0,
    columnPermissions: 0,
    validation: 0,
    relations: 0,
  };
  const forget = async () => {
    for (const t of ['zvd_relations']) {
      await sql`DELETE FROM ${sql.table(t)} WHERE source_collection IN (${sql.join(ALL)})
                 OR target_collection IN (${sql.join(ALL)})`.execute(db);
    }
    await sql`DELETE FROM zvd_rls_policies WHERE collection IN (${sql.join(ALL)})`.execute(db);
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name IN (${sql.join(ALL)})`.execute(
      db,
    );
    await sql`DELETE FROM zv_validation_rules WHERE collection IN (${sql.join(ALL)})`.execute(db);
    await sql`DROP TABLE IF EXISTS zvd_jnc_po_items_po_tags CASCADE`.execute(db);
    for (const c of ALL) await dropTestCollection(db, c);
  };
  /** Installed, enabled by god, with an operator collection beside it. */
  const enabled = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    await forget();
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await DDLManager.createCollection(db, { name: PLAIN, fields: [text('x')] } as never);
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    manifest.collections = OWNED;
    rmSync(join(base, NAME), { recursive: true, force: true });
    await Bun.write(join(base, NAME, 'manifest.json'), JSON.stringify(manifest));
    await Bun.write(
      join(base, NAME, 'engine/index.js'),
      `export default { name: ${JSON.stringify(NAME)}, category: 'fixture', async register() {} };`,
    );
    const file = (name: string, body: Record<string, unknown>) =>
      Bun.write(
        join(base, NAME, `schema/collections/${name}.json`),
        JSON.stringify({ name, ...body }),
      );
    await file(ITEMS, {
      fields: [text('title')],
      relations: [{ name: 'po_items_tags', type: 'm2m', field: 'tags', target: TAGS }],
    });
    await file(TAGS, { fields: [text('label')] });
    manifest.integrity = { schemaSha256: schemaDigest(await readSchemaDir(join(base, NAME))) };
    await Bun.write(join(base, NAME, 'manifest.json'), JSON.stringify(manifest));
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
    const r = await call('POST', `/api/marketplace/${NAME}/enable`, {});
    expect(r.status).toBe(200);
    expect(
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM zvd_collections
                                  WHERE owner_extension = ${NAME}`.execute(db)
      ).rows[0]?.n,
    ).toBe(2);
  };

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-purgeowned-'));
    process.env.EXTENSIONS_DIR = base;
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
    if (db) {
      await forget();
      await sql`DELETE FROM zvd_permissions WHERE v2 IN (${sql.join(ALL)})`.execute(db);
      await sql`DELETE FROM zv_default_grant_revocations WHERE resource IN (${sql.join(ALL)})`.execute(
        db,
      );
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('uninstall keeps everything; purge leaves nothing; the name comes back clean', async () => {
    await enabled();
    const junction = (
      await sql<{ j: string }>`SELECT junction_table AS j FROM zvd_relations
                                WHERE type = 'm2m' AND source_collection = ${ITEMS}`.execute(db)
    ).rows[0]?.j;
    expect(junction).toMatch(/^zvd_/);

    // What an operator adds to an owned collection.
    expect((await call('POST', `/api/collections/${ITEMS}/fields`, text(`${P}note`))).status).toBe(
      200,
    );
    const rule = await call('POST', '/api/admin/rls', {
      collection: ITEMS,
      role: 'tenant_member',
      filter_field: 'title',
      filter_value_source: 'static:x',
    });
    expect(rule.status).toBe(201);
    const perm = await call('POST', '/api/admin/column-permissions', {
      collection_name: ITEMS,
      column_name: `${P}note`,
      role: 'tenant_member',
      can_read: false,
      can_write: false,
    });
    expect(perm.status).toBe(201);
    await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, error_message)
              VALUES (${ITEMS}, 'title', 'required', 'needed')`.execute(db);
    // A grant in a tenant's domain, and a revoked default.
    await (await getEnforcer()).addPolicy('tenant_member', TENANT, ITEMS, 'delete');
    const revoke = await call('DELETE', '/api/permissions/policies', {
      subject: 'tenant_viewer',
      resource: ITEMS,
      action: 'read',
    });
    expect(revoke.status).toBe(200);
    expect((await call('POST', `/api/data/${ITEMS}`, { title: 'kept' })).status).toBe(201);

    const before = await leftovers(OWNED);
    expect(before.rowRules * before.columnPermissions * before.validation).toBe(1);
    expect(before.revocations).toBe(1);

    // Uninstall without purge: the data and every rule stay.
    expect((await uninstall(false)).status).toBe(200);
    expect(await leftovers(OWNED)).toEqual(before);
    const kept = await sql<{ title: string }>`SELECT title FROM zvd_po_items`.execute(db);
    expect(kept.rows.map((r) => r.title)).toEqual(['kept']);

    // Purge: tables and junction gone, nothing names them anywhere.
    const purged = await uninstall(true);
    expect([purged.status, ((await purged.json()) as { purged?: boolean }).purged]).toEqual([
      200,
      true,
    ]);
    for (const c of OWNED) expect(await DDLManager.tableExists(db, c)).toBe(false);
    const j = await sql<{ t: string | null }>`SELECT to_regclass(${junction})::text AS t`.execute(
      db,
    );
    expect(j.rows[0]?.t).toBeNull();
    expect(await leftovers(OWNED)).toEqual(none);
    expect(await (await getEnforcer()).hasPolicy('tenant_member', TENANT, ITEMS, 'delete')).toBe(
      false,
    );

    // The same name, created by an operator: an ordinary collection with its defaults only.
    await DDLManager.createCollection(db, { name: ITEMS, fields: [text('title')] } as never);
    const fresh = await sql<{ owner: string | null }>`SELECT owner_extension AS owner
                                                       FROM zvd_collections WHERE name = ${ITEMS}`.execute(
      db,
    );
    expect(fresh.rows).toEqual([{ owner: null }]);
    expect(
      ((await DDLManager.getCollection(db, ITEMS))?.fields as { name: string }[] | undefined)?.map(
        (f) => f.name,
      ),
    ).toEqual(['title']);
    const after = await leftovers([ITEMS]);
    expect({ ...after, permissions: 0, collections: 0 }).toEqual(none);
    const grants = await sql<{ g: string }>`SELECT v0 || ' ' || v1 || ' ' || v3 AS g
                                             FROM zvd_permissions WHERE v2 = ${ITEMS} ORDER BY 1`.execute(
      db,
    );
    // The revoked default is a default again; the tenant's grant is gone.
    expect(grants.rows.map((r) => r.g)).toContain('tenant_viewer * read');
    expect(grants.rows.every((r) => r.g.split(' ')[1] === '*')).toBe(true);
  }, 90_000);

  it("an operator's m2o into an owned collection refuses the purge until it is removed", async () => {
    await enabled();
    const rel = await call('POST', '/api/relations', {
      name: `${PLAIN}_item`,
      type: 'm2o',
      source_collection: PLAIN,
      source_field: 'item_id',
      target_collection: ITEMS,
    });
    expect(rel.status).toBe(201);

    const refused = await uninstall(true);
    const body = (await refused.json()) as { detail?: string; errors?: string[] };
    expect([refused.status, body.detail]).toEqual([409, 'EXT_COLLECTIONS_REFERENCED']);
    expect(body.errors?.[0]).toContain(
      `${PLAIN}.item_id -> ${ITEMS} references a collection it owns`,
    );
    // Nothing was dropped and the extension's record stays.
    for (const c of [...OWNED, PLAIN]) expect(await DDLManager.tableExists(db, c)).toBe(true);
    const row = await sql`SELECT 1 FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    expect(row.rows).toHaveLength(1);

    expect((await call('DELETE', `/api/collections/${PLAIN}/fields/item_id`)).status).toBe(200);
    expect((await uninstall(true)).status).toBe(200);
    for (const c of OWNED) expect(await DDLManager.tableExists(db, c)).toBe(false);
    expect(await leftovers(OWNED)).toEqual(none);
    expect(await DDLManager.tableExists(db, PLAIN)).toBe(true);
  }, 90_000);

  it('an ordinary drop leaves no row rule behind', async () => {
    await forget();
    await DDLManager.createCollection(db, { name: PLAIN, fields: [text('x')] } as never);
    const rule = await call('POST', '/api/admin/rls', {
      collection: PLAIN,
      role: 'tenant_member',
      filter_field: 'x',
      filter_value_source: 'static:x',
    });
    expect(rule.status).toBe(201);
    expect((await call('DELETE', `/api/collections/${PLAIN}`)).status).toBe(200);
    expect(await leftovers([PLAIN])).toEqual(none);
  }, 60_000);
});
