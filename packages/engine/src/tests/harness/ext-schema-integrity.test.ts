/**
 * ADR 0012 amendment 1 point 4: an extension's schema files are covered by
 * `integrity.schemaSha256`, which `zveltio extension pack` writes and each load
 * checks, on both load paths (engine and `contributes.engine: false`). A file
 * changed after pack is refused, and so is a manifest that declares collections
 * without the digest.
 *
 * Also: a declared collection's `indexes` is created with it, owned like the
 * rest of its structure.
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
import { readSchemaDir, schemaDigest } from '../../lib/extensions/declared-collections.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import {
  createSteppedUpGod,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = 'hello-ext';
const ITEMS = 'integ_items';
const STUDIO = 'integ_studio';
const ALL = [ITEMS, STUDIO];
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');
const CLI = join(import.meta.dir, '../../../../cli/src/index.ts');
const ITEMS_FILE = {
  name: ITEMS,
  fields: [
    { name: 'list', type: 'text' },
    { name: 'title', type: 'text' },
  ],
  indexes: [{ fields: ['list', 'title'], unique: true }],
};

/**
 * The CLI's `hashSchemaFiles` pins the same vector (extension-pack.test.ts): the
 * two computations live in packages that cannot import each other.
 */
const GOLDEN = {
  files: { 'collections/a.json': '{"name":"a"}\n', 'migrations/20261029T000000-x.json': '{}' },
  digest: '9346cfe3eb9c3949318c84e1a0b105ac294f420481ce6c1edd365ec35fdc4f13',
};

d('extension schema files are checked against the digest pack wrote', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const saved = { extDir: process.env.EXTENSIONS_DIR, ctx: extensionLoader.ctx };
  const dir = () => join(base, NAME);

  /** The package, unpacked: its manifest declares `files` and records no digest. */
  const ship = async (files: Record<string, unknown>, patch: Record<string, unknown> = {}) => {
    const manifest = {
      ...JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8')),
      ...patch,
    };
    delete manifest.integrity;
    manifest.collections = Object.keys(files);
    rmSync(join(dir(), 'schema'), { recursive: true, force: true });
    for (const [name, file] of Object.entries(files)) {
      await Bun.write(join(dir(), `schema/collections/${name}.json`), JSON.stringify(file));
    }
    await Bun.write(join(dir(), 'manifest.json'), JSON.stringify(manifest));
  };
  const pack = () => {
    const r = Bun.spawnSync([process.execPath, CLI, 'extension', 'pack', '--dir', dir()]);
    expect(r.exitCode).toBe(0);
  };
  /** Records the digest as pack does for an extension with an engine bundle. */
  const record = async () => {
    const manifest = JSON.parse(readFileSync(join(dir(), 'manifest.json'), 'utf8'));
    manifest.integrity = { schemaSha256: schemaDigest(await readSchemaDir(dir())) };
    await Bun.write(join(dir(), 'manifest.json'), JSON.stringify(manifest));
  };
  const tamper = (name: string) =>
    Bun.write(
      join(dir(), `schema/collections/${name}.json`),
      readFileSync(join(dir(), `schema/collections/${name}.json`), 'utf8').replace(
        '"fields":[',
        '"fields":[{"name":"planted","type":"text"},',
      ),
    );
  const reset = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    for (const c of ALL) await dropTestCollection(db, c);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, false)`.execute(db);
  };
  const enable = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    const r = await engine.request(`/api/marketplace/${NAME}/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: '{}',
    });
    const e = await sql<{ e: string | null }>`SELECT last_load_error AS e FROM zv_extension_registry
                                               WHERE name = ${NAME} AND tenant_id IS NULL`.execute(
      db,
    );
    return `${r.status} ${e.rows[0]?.e ?? ''}`;
  };

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    ({ app: engine, cookie: god } = await createSteppedUpGod(t.app, db));
    base = mkdtempSync(join(tmpdir(), 'zv-schemainteg-'));
    process.env.EXTENSIONS_DIR = base;
    _resetCatalogCacheForTests();
    await Bun.write(
      join(dir(), 'engine/index.js'),
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
      for (const c of ALL) await dropTestCollection(db, c);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('computes the digest the CLI pins', () => {
    const files = new Map(
      Object.entries(GOLDEN.files).map(([p, c]) => [p, new TextEncoder().encode(c)]),
    );
    expect(schemaDigest(files)).toBe(GOLDEN.digest);
  });

  it('engine path: loads untampered, with its unique index; refuses a changed file and no digest', async () => {
    await reset();
    await ship({ [ITEMS]: ITEMS_FILE });
    expect(await enable()).toMatch(/no integrity\.schemaSha256/);
    expect(await DDLManager.tableExists(db, ITEMS)).toBe(false);

    await record();
    expect(await enable()).toBe('200 ');
    const keys = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = ${`zvd_${ITEMS}`}::regclass AND contype = 'u'`.execute(db);
    expect(keys.rows.map((r) => r.def)).toEqual(['UNIQUE (tenant_id, list, title)']);

    await tamper(ITEMS);
    expect(await enable()).toMatch(/integrity check failed: manifest declares schemaSha256=/);
    const cols = (await DDLManager.getCollection(db, ITEMS))?.fields as { name: string }[];
    expect(cols.map((f) => f.name)).not.toContain('planted');

    // A planted file the manifest does not even name changes the digest too.
    await record();
    expect(await enable()).toBe('200 ');
    await Bun.write(join(dir(), 'schema/migrations/20261029T000000-x.json'), '{}');
    expect(await enable()).toMatch(/integrity check failed/);
  }, 60_000);

  it('engine: false path: pack writes the digest, an edit after pack is refused', async () => {
    await reset();
    rmSync(join(dir(), 'schema'), { recursive: true, force: true });
    await ship(
      { [STUDIO]: { name: STUDIO, fields: [{ name: 'title', type: 'text' }] } },
      { contributes: { engine: false, studio: true } },
    );
    expect(await enable()).toMatch(/no integrity\.schemaSha256/);

    pack();
    const { integrity } = JSON.parse(readFileSync(join(dir(), 'manifest.json'), 'utf8'));
    expect(integrity).toEqual({ schemaSha256: schemaDigest(await readSchemaDir(dir())) });
    expect(await enable()).toBe('200 ');
    expect(await DDLManager.tableExists(db, STUDIO)).toBe(true);

    await tamper(STUDIO);
    expect(await enable()).toMatch(/integrity check failed/);
  }, 60_000);
});
