/**
 * A replica's boot never loads an extension another replica purged meanwhile.
 *
 * Boot (`loadFromDB`) read the registry once, unlocked, then loaded what it read.
 * A purge on another replica holds the extension's lock, but the boot's load did
 * not ask for it: a purge landing between the read and the load dropped the
 * tables, the migration rows and the registry row, and the boot then loaded the
 * extension anyway — its migrations, no longer on record, ran again and put the
 * tables back. The extension ran with no registry row behind it until a sync
 * unloaded it, and its tables stayed behind for good (no row: nothing purges them).
 *
 * The boot now loads each extension under its lock and reads the registry again
 * there, as the lifecycle sync does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { type KyselyPlugin, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import {
  _resetExtensionDbRoleForTests,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { withExtensionLock } from '../../lib/extensions/extension-utils.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { purgeExtensionData } from '../../lib/extensions/migration-runner.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// In the bundled catalog as first-party, so it may load inline.
const NAME = 'hello-ext';
const TABLE = 'zv_hello_ext_bootpurge';
const FIXTURE = join(import.meta.dir, '../fixtures/hello-ext');

d('boot beside a purge on another replica', () => {
  let db: Database;
  let base = '';
  const saved = process.env.EXTENSIONS_DIR;

  const tableExists = async () =>
    (await sql<{ t: string | null }>`SELECT to_regclass(${TABLE})::text AS t`.execute(db)).rows[0]
      ?.t != null;
  const migrationRows = async () =>
    (
      await sql<{ n: number }>`SELECT count(*)::int AS n FROM zv_migrations
                                WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db)
    ).rows[0]?.n;

  const newReplica = () => {
    const loader = new ExtensionLoader();
    loader.ctx = {
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    return loader;
  };

  /** What the uninstall route does with ?purgeData=true, on another replica. */
  const purgeElsewhere = () =>
    withExtensionLock(db, NAME, async () => {
      await purgeExtensionData(NAME, db);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    });

  beforeAll(async () => {
    ({ db } = await getTestApp());
    base = mkdtempSync(join(tmpdir(), 'zv-bootpurge-'));
    process.env.EXTENSIONS_DIR = base;
    _resetCatalogCacheForTests();
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
    delete manifest.integrity;
    await Bun.write(join(base, NAME, 'manifest.json'), JSON.stringify(manifest));
    await Bun.write(
      join(base, NAME, 'engine/index.js'),
      `import { join } from 'node:path';
       export default {
         name: ${JSON.stringify(NAME)},
         category: 'fixture',
         getMigrations: () => [join(import.meta.dir, 'migrations/001_rows.sql')],
         async register() {},
       };`,
    );
    await Bun.write(
      join(base, NAME, 'engine/migrations/001_rows.sql'),
      `CREATE TABLE ${TABLE} (id int);\n-- DOWN\nDROP TABLE IF EXISTS ${TABLE};\n`,
    );
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = saved;
    if (db) {
      await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
    _resetExtensionDbRoleForTests();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('a purge landing after the boot read the registry: nothing loads, nothing comes back', async () => {
    // Installed and enabled, its migration run, by an earlier boot.
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, true, true)`.execute(db);
    const earlier = newReplica();
    await earlier.loadFromDB(db, new Hono(), []);
    expect(earlier.isActive(NAME)).toBe(true);
    await earlier.unload(NAME);
    expect(await tableExists()).toBe(true);

    // The boot's first registry read returns, then the other replica purges.
    let purged = false;
    const purgeAfterRead: KyselyPlugin = {
      transformQuery: (a) => a.node,
      async transformResult(a) {
        if (!purged) {
          purged = true;
          await purgeElsewhere();
        }
        return a.result;
      },
    };
    const replica = newReplica();
    await replica.loadFromDB(db.withPlugin(purgeAfterRead), new Hono(), []);
    expect(purged).toBe(true);

    expect(replica.isActive(NAME)).toBe(false);
    expect(await tableExists()).toBe(false);
    expect(await migrationRows()).toBe(0);
    await replica.unload(NAME).catch(() => undefined);
  }, 60_000);
});
