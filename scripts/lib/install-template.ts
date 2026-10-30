/**
 * Building the database a real install produces.
 *
 * Engine migrations, then every extension's migrations and declared collections,
 * into one scratch database — which is what a customer's first install does and
 * what no other check had. Several
 * tools need it, and they must agree: a second copy of "apply the migrations in
 * order" is exactly the kind of drift this project keeps paying for.
 *
 * Extracted from `check-insert-schema-match.ts`, which built it first and whose
 * comments carry the reasons the details are the way they are.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SQL } from 'bun';
import {
  isNonTransactional,
  splitSqlStatements,
} from '../../packages/engine/src/db/migrations/index.js';
import { SQL as Sql } from 'bun';
import { SIBLING_ROOT } from './require-sibling.js';

export const ROOT = join(import.meta.dir, '..', '..');
export const EXT_ROOT = SIBLING_ROOT;
export const ENGINE_MIGRATIONS = join(ROOT, 'packages', 'engine', 'src', 'db', 'migrations', 'sql');

/** Admin connection: `SEAM_DATABASE_URL`, or PG* env, or a local default. */
export const ADMIN_URL =
  process.env.SEAM_DATABASE_URL ??
  `postgres://${process.env.PGUSER ?? 'postgres'}:${process.env.PGPASSWORD ?? 'postgres'}@${
    process.env.PGHOST ?? 'localhost'
  }:${process.env.PGPORT ?? '5432'}/postgres`;

/** The admin URL pointed at a different database on the same server. */
export function dbUrl(name: string): string {
  return ADMIN_URL.replace(/\/postgres(\?|$)/, `/${name}$1`);
}

/**
 * Strip everything from the `-- DOWN` marker on: that half is rollback SQL, and
 * applying it drops the tables the UP half just created.
 *
 * `\s*$`, not `\b` — the marker is a line that is exactly `-- DOWN`. The loose
 * form also matches `-- DOWN: manual rollback required`, which is prose, and the
 * engine's `001_initial.sql` contains that exact line. Cutting there discarded
 * most of the schema and made five later migrations and twenty extensions look
 * broken. Same rule as `db/migrations/index.ts`.
 */
export function upHalf(sql: string): string {
  const m = /^[ \t]*--[ \t]*DOWN[ \t]*$/im.exec(sql);
  return m ? sql.slice(0, m.index) : sql;
}

/** Every directory holding a `manifest.json` and an `engine/`, sorted. */
export function extensionDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 4 || !existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, 'manifest.json')) && existsSync(join(p, 'engine'))) out.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** Engine migration files, in the order the runner applies them. */
export function engineMigrationFiles(): string[] {
  return readdirSync(ENGINE_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

/**
 * Create `dbName` and apply the engine's migrations, then every extension's.
 *
 * Returns the migrations that failed, as `owner/file: message`. Failures do not
 * stop the build: a caller usually wants the schema that DID apply plus the list
 * of what did not, rather than nothing at all.
 *
 * Both halves matter. Building only the engine, or only one extension's own
 * tables, answers a smaller question than the one being asked — `ecommerce/store`
 * writes `zvd_products`, which `operations/inventory` owns, and a store-only
 * database made that check skip rather than fail.
 */
/**
 * Apply one migration's UP half the way the RUNNER would.
 *
 * `db.unsafe(wholeFile)` sends every statement as one batch, which Postgres
 * executes in an implicit transaction — so a file marked `-- NO TRANSACTION`
 * failed here with "CREATE INDEX CONCURRENTLY cannot run inside a transaction
 * block" while running perfectly through the engine. Every schema this file
 * builds is a claim about what a customer's database looks like, and it was a
 * claim the runner did not agree with.
 *
 * Both the marker check and the splitter are the engine's own, so the tooling
 * and the runner cannot drift into disagreeing about what a file is.
 */
async function applyUp(db: Sql, up: string): Promise<void> {
  if (!isNonTransactional(up)) {
    await db.unsafe(up);
    return;
  }
  for (const stmt of splitSqlStatements(up)) {
    await db.unsafe(stmt);
  }
}

/**
 * An extension's declared collections (ADR 0012), applied by the engine's own
 * code: the files are checked against the manifest's `schemaSha256` and planned
 * and created exactly as `loadExtension` does. ADR 0012 moved those tables out
 * of SQL; built from SQL alone, this install lost each one as its extension was
 * ported, and the snapshot and the numeric gate with it.
 *
 * The engine is imported, and its pool opened, only for the first extension
 * that declares any: the gates' own tests run this file from a copy holding
 * nothing but the engine's migrations.
 */
class Declared {
  private db: import('../../packages/engine/src/db/index.js').Database | undefined;
  constructor(private readonly dbName: string) {}

  async apply(name: string, dir: string): Promise<void> {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      collections?: string[];
      integrity?: { schemaSha256?: string };
    };
    if (!manifest.collections?.length) return;
    const { applyDeclaredCollections, readDeclaredCollections } = await import(
      '../../packages/engine/src/lib/extensions/declared-collections.js'
    );
    if (!this.db) {
      const { createDb } = await import('../../packages/engine/src/db/index.js');
      const { fieldTypeRegistry } = await import('../../packages/engine/src/lib/data/index.js');
      const { registerCoreFieldTypes } = await import(
        '../../packages/engine/src/field-types/index.js'
      );
      // Boot registers these before any extension loads; a declared field is one of them.
      registerCoreFieldTypes(fieldTypeRegistry);
      // Bun.SQL opens a pool's whole `max` at once, and the engine's default is
      // sized for a server, not a scratch build beside CI's other jobs.
      const max = process.env.DB_POOL_MAX;
      process.env.DB_POOL_MAX = '4';
      try {
        this.db = createDb(dbUrl(this.dbName));
      } finally {
        if (max === undefined) delete process.env.DB_POOL_MAX;
        else process.env.DB_POOL_MAX = max;
      }
    }
    const files = await readDeclaredCollections(
      name,
      dir,
      manifest.collections,
      manifest.integrity?.schemaSha256,
    );
    // After each create the engine tells its running self — the enforcer's
    // model, branch previews, the other replicas. Nothing runs on this
    // database, so those say only that, once per collection; anything else
    // still prints.
    const quiet = /^\[(resource-grants|schema-branches|realtime-bus)\] /;
    const { warn, error } = console;
    const filter =
      (to: (...a: unknown[]) => void) =>
      (...a: unknown[]): void => {
        if (!quiet.test(String(a[0]))) to(...a);
      };
    console.warn = filter(warn);
    console.error = filter(error);
    try {
      await applyDeclaredCollections(this.db, name, files, true);
      // ponytail: the notices are fire-and-forget jobs; one tick lets them land under the filter.
      await Bun.sleep(0);
    } finally {
      console.warn = warn;
      console.error = error;
    }
  }

  async end(): Promise<void> {
    await this.db?.destroy();
  }
}

export async function buildInstallTemplate(admin: SQL, dbName: string): Promise<string[]> {
  const problems: string[] = [];
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const db = new Sql(dbUrl(dbName));
  try {
    await db.unsafe(
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    );
    for (const f of engineMigrationFiles()) {
      try {
        await applyUp(db, upHalf(readFileSync(join(ENGINE_MIGRATIONS, f), 'utf8')));
      } catch (err) {
        problems.push(`engine/${f}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    // The default tenant every extension migration backfills against.
    await db.unsafe(
      `INSERT INTO zv_tenants (id, slug, name)
       VALUES ('00000000-0000-0000-0000-000000000001', 'root', 'Root')
       ON CONFLICT DO NOTHING`,
    );
    // In the engine's load order (dependencies first, then each extension's
    // migrations, then its declared collections — `loadExtension`), because
    // SQL reaches across extensions: `operations/pos` attaches its FK to
    // `zvd_contacts` only when CRM's table is already there.
    const dirs = extensionDirs(EXT_ROOT);
    const names = dirs.map((d) => d.slice(EXT_ROOT.length + 1));
    // Imported only when there is something to order (see `Declared`).
    const order =
      names.length > 1
        ? await (
            await import('../../packages/engine/src/lib/extensions/discovery.js')
          ).topoSortExtensions(names, EXT_ROOT)
        : names;
    const declared = new Declared(dbName);
    try {
      for (const name of order) {
        const dir = join(EXT_ROOT, name);
        const migDir = join(dir, 'engine', 'migrations');
        // Directory order, as the engine loads a runner extension (manifest
        // `isolation: 'worker'`, never imported in-process). First-party ones run
        // inline in getMigrations() order; the extensions repo's
        // validate-migration-paths holds that list to this same order.
        const files = existsSync(migDir)
          ? readdirSync(migDir)
              .filter((x) => x.endsWith('.sql'))
              .sort()
          : [];
        for (const f of files) {
          try {
            await applyUp(db, upHalf(readFileSync(join(migDir, f), 'utf8')));
          } catch (err) {
            problems.push(`${name}/${f}: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        try {
          await declared.apply(name, dir);
        } catch (err) {
          problems.push(`${name}/schema/collections: ${(err as Error).message.split('\n')[0]}`);
        }
      }
    } finally {
      await declared.end();
    }
  } finally {
    await db.end();
  }
  return problems;
}
