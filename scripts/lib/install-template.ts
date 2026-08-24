/**
 * Building the database a real install produces.
 *
 * Engine migrations, then every extension's, into one scratch database — which
 * is what a customer's first install does and what no other check had. Several
 * tools need it, and they must agree: a second copy of "apply the migrations in
 * order" is exactly the kind of drift this project keeps paying for.
 *
 * Extracted from `check-insert-schema-match.ts`, which built it first and whose
 * comments carry the reasons the details are the way they are.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { SQL as Sql } from 'bun';

export const ROOT = join(import.meta.dir, '..', '..');
export const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');
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
        await db.unsafe(upHalf(readFileSync(join(ENGINE_MIGRATIONS, f), 'utf8')));
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
    for (const dir of extensionDirs(EXT_ROOT)) {
      const migDir = join(dir, 'engine', 'migrations');
      if (!existsSync(migDir)) continue;
      for (const f of readdirSync(migDir)
        .filter((x) => x.endsWith('.sql'))
        .sort()) {
        try {
          await db.unsafe(upHalf(readFileSync(join(migDir, f), 'utf8')));
        } catch (err) {
          problems.push(
            `${dir.slice(EXT_ROOT.length + 1)}/${f}: ${(err as Error).message.split('\n')[0]}`,
          );
        }
      }
    }
  } finally {
    await db.end();
  }
  return problems;
}
