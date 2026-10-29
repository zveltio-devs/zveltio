/**
 * Engine gaps the ADR 0012 pilot (`projects/management`) found:
 *
 * A. A collection named like a business name the v1 seed granted on (`projects`)
 *    is refused for "existing rules" on a fresh instance; migration 105 removes
 *    those seeded rules.
 * B. A required m2o field gets a NOT NULL foreign key, through the data API; a
 *    nullable one under a required field is planned as drift and repaired.
 * C. A relation entry that leaves out the engine's defaults (`targetField`,
 *    `onUpdate`, `metadata`) plans nothing once applied, so a firm may activate.
 * D. A Studio-only extension (`contributes.engine: false`) gets its declared
 *    collections, under the same rules as any other.
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
import { readSchemaDir, schemaDigest } from '../../lib/extensions/declared-collections.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { planExtensionSchema } from '../../lib/schema-artifact/apply.js';
import { nonCollectionObjects } from '../../lib/tenancy/resource-grants.js';
import {
  createSteppedUpGod,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = 'hello-ext';
const PROJECTS = 'projects';
const PARENT = 'wave_parent';
const CHILD = 'wave_child';
const STUDIO = 'wave_studio';
const ALL = [CHILD, PARENT, PROJECTS, STUDIO];
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const text = (name: string) => ({ name, type: 'text' });

/** Every object migration 001 granted on that is neither an engine object nor a collection. */
const SEEDED = [
  'api-connector',
  'approvals',
  'assets',
  'checklists',
  'crm',
  'document-templates',
  'documents',
  'efactura',
  'etransport',
  'expenses',
  'export',
  'forms',
  'helpdesk',
  'import',
  'intranet',
  'inventory',
  'invoices',
  'leave',
  'media',
  'portal',
  'pos',
  'postgis',
  'procurement',
  'projects',
  'quotes',
  'ro-documents',
  'saft',
  'search',
  'store',
  'subscriptions',
  'time-tracking',
  'translations',
  'zvd_*',
];

// A required m2o, its relation written without the engine's defaults.
const CHILD_FILE = {
  fields: [
    { name: 'parent_id', type: 'm2o', required: true, options: { related_collection: PARENT } },
    text('title'),
  ],
  relations: [
    {
      name: `${CHILD}_parent_id`,
      type: 'm2o',
      field: 'parent_id',
      target: PARENT,
      onDelete: 'CASCADE',
    },
  ],
};

d('ADR 0012 pilot gaps: seeded names, required keys, relation defaults, Studio-only', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };

  const ship = async (
    collections: Record<string, { name: string; type: string }[] | Record<string, unknown>>,
    manifestPatch: Record<string, unknown> = {},
  ) => {
    const manifest = {
      ...JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8')),
      ...manifestPatch,
    };
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
  const forget = async () => {
    await sql`DELETE FROM zvd_relations WHERE source_collection IN (${sql.join(ALL)})`.execute(db);
    for (const c of ALL) await dropTestCollection(db, c);
  };
  const reset = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    await forget();
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
  };
  const call = (method: string, path: string, body?: unknown) =>
    engine.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const post = (action: string) => call('POST', `/api/marketplace/${NAME}/${action}`, {});
  const lastLoadError = async () =>
    (
      await sql<{ e: string | null }>`SELECT last_load_error AS e FROM zv_extension_registry
                                       WHERE name = ${NAME} AND tenant_id IS NULL`.execute(db)
    ).rows[0]?.e;
  const files = async (names: string[]) =>
    Object.fromEntries(
      await Promise.all(
        names.map(async (n) => [
          `collections/${n}.json`,
          await Bun.file(join(base, NAME, `schema/collections/${n}.json`)).text(),
        ]),
      ),
    );

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-declwave-'));
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

  it('A: no seeded rule is left on a business name, and a declared `projects` is created', async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    // What a registered extension still claims (v1 `resources`) is its own, until the wave.
    const claimed = await nonCollectionObjects(db);
    const left = await sql<{ v2: string }>`
      SELECT DISTINCT v2 FROM zvd_permissions
       WHERE ptype = 'p' AND v2 IN (${sql.join(SEEDED)})
         AND v2 NOT IN (SELECT name FROM zvd_collections)`.execute(db);
    expect(left.rows.map((r) => r.v2).filter((n) => !claimed.has(n))).toEqual([]);

    // Not `reset()`: dropping the fixture deletes the rules on its name, the ones under test.
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
    await ship({ [PROJECTS]: [text('title')] });
    const r = await post('enable');
    expect(`${r.status} ${(await lastLoadError()) ?? ''}`).toBe('200 ');
    expect(await owner(PROJECTS)).toEqual({ owner_extension: NAME });
  }, 60_000);

  it('B: a required m2o is NOT NULL through the data API; C: omitted relation defaults owe nothing', async () => {
    await reset();
    await ship({ [PARENT]: [text('name')], [CHILD]: CHILD_FILE });
    expect((await post('enable')).status).toBe(200);

    const parent = await call('POST', `/api/data/${PARENT}`, { name: 'p' });
    expect(parent.status).toBe(201);
    const parentId = (await parent.json()) as { data?: { id: string }; id?: string };
    const pid = parentId.data?.id ?? parentId.id;
    const orphan = await call('POST', `/api/data/${CHILD}`, { title: 'no parent' });
    expect(orphan.status).toBe(422);
    const child = await call('POST', `/api/data/${CHILD}`, { title: 'kid', parent_id: pid });
    expect(child.status).toBe(201);
    const cj = (await child.json()) as { data?: { id: string }; id?: string };
    const cleared = await call('PATCH', `/api/data/${CHILD}/${cj.data?.id ?? cj.id}`, {
      parent_id: null,
    });
    expect(cleared.status).toBe(422);

    // C: nothing owed, so a firm's activate loads it.
    expect(await planExtensionSchema(db, NAME, await files([PARENT, CHILD]))).toEqual([]);
    expect((await post('disable')).status).toBe(200);
    const act = await post('activate');
    expect(`${act.status} ${(await lastLoadError()) ?? ''}`).toBe('200 ');
  }, 60_000);

  it('B: a nullable key under a required field is drift the next apply repairs', async () => {
    await reset();
    await ship({ [PARENT]: [text('name')], [CHILD]: CHILD_FILE });
    expect((await post('enable')).status).toBe(200);
    await sql`ALTER TABLE ${sql.id(`zvd_${CHILD}`)} ALTER COLUMN parent_id DROP NOT NULL`.execute(
      db,
    );
    const steps = await planExtensionSchema(db, NAME, await files([PARENT, CHILD]));
    expect(steps.map((s) => `${s.change} ${s.target} ${s.action} ${!!s.op}`)).toEqual([
      `~ ${CHILD} alter field parent_id (required) true`,
    ]);
    await extensionLoader.unload(NAME);
    expect((await post('enable')).status).toBe(200);
    expect(await planExtensionSchema(db, NAME, await files([PARENT, CHILD]))).toEqual([]);
    const nn = await sql<{ n: boolean }>`
      SELECT attnotnull AS n FROM pg_attribute
       WHERE attrelid = ${`zvd_${CHILD}`}::regclass AND attname = 'parent_id'`.execute(db);
    expect(nn.rows[0]?.n).toBe(true);
  }, 60_000);

  it('D: a Studio-only extension gets its declared collections, on the same terms', async () => {
    await reset();
    await ship({ [STUDIO]: [text('title')] }, { contributes: { engine: false, studio: true } });
    const firm = await post('activate');
    expect(firm.status).toBe(409);
    expect(await DDLManager.tableExists(db, STUDIO)).toBe(false);

    expect((await post('enable')).status).toBe(200);
    expect(await owner(STUDIO)).toEqual({ owner_extension: NAME });
    expect(await DDLManager.tableExists(db, STUDIO)).toBe(true);
  }, 60_000);
});
