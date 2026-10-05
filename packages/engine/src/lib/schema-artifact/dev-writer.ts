/**
 * Schema as code, step 4 (docs/engine/rfc-schema-as-code.md §7): in dev, the
 * engine keeps `schema/` in step with every change made through it.
 *
 * Enabled by `ZVELTIO_SCHEMA_DIR` outside production. A request that changed
 * something rewrites the directory from `exportSchema` once it has committed —
 * the bytes `zveltio schema pull` writes. A rename, type change or drop made
 * through the routes also writes its migration (§4.4), the one moment its intent
 * is known, and records it as applied: this database already ran it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { onAfterCommit } from '../tenancy/index.js';
import { exportSchema, serialize } from './export.js';
import { type MigrationOp, migrationChecksum } from './plan.js';

/** The directory to write, or null when the writer is off. Read per call. */
export function schemaDir(): string | null {
  const dir = process.env.ZVELTIO_SCHEMA_DIR;
  return dir && process.env.NODE_ENV !== 'production' ? dir : null;
}

let pool: Database | null = null;
let running: Promise<void> | null = null;
let again = false;

/**
 * Registered before the tenant middleware, so it runs after the request's
 * transaction has committed. Data writes do not change the schema and are
 * skipped; anything else that succeeded triggers a write.
 */
export function schemaDevWriter(db: Database): MiddlewareHandler {
  pool = db;
  return async (c, next) => {
    await next();
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return;
    if (!c.res.ok || c.req.path.startsWith('/api/data/')) return;
    scheduleSchemaWrite();
  };
}

/** Coalesces: one write runs at a time, and a change during it runs one more. */
export function scheduleSchemaWrite(): void {
  const dir = schemaDir();
  const db = pool;
  if (!dir || !db) return;
  if (running) {
    again = true;
    return;
  }
  running = (async () => {
    do {
      again = false;
      await writeSchemaFiles(db, dir);
    } while (again);
  })()
    .catch((err) => console.error('[schema dev writer] write failed:', err))
    .finally(() => {
      running = null;
    });
}

/** Resolves when no write is pending. For tests. */
export const schemaWriteSettled = (): Promise<void> => running ?? Promise.resolve();

/**
 * What `schema pull` does: every exported file, and no collection file without
 * a collection. Unchanged files are not touched, so a watcher sees only the
 * change. Migrations are never removed.
 */
export async function writeSchemaFiles(db: Database, dir: string): Promise<void> {
  const files = await exportSchema(db);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (existsSync(target) && readFileSync(target, 'utf8') === content) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const collectionsDir = join(dir, 'collections');
  if (!existsSync(collectionsDir)) return;
  for (const f of readdirSync(collectionsDir)) {
    if (f.endsWith('.json') && !(`collections/${f}` in files)) rmSync(join(collectionsDir, f));
  }
}

/** Called by the route that made the change; written once it has committed. */
export function recordSchemaMigration(...ops: MigrationOp[]): void {
  const dir = schemaDir();
  const db = pool;
  if (!dir || !db || !ops.length) return;
  onAfterCommit(async () => {
    await writeMigration(db, dir, ops).catch((err) =>
      console.error('[schema dev writer] migration not written:', err),
    );
  });
}

/**
 * `migrations/<id>.json`, recorded in `zv_schema_migrations` with the checksum
 * `apply` computes, so an apply against this database does not run it again.
 * The id carries milliseconds: ids run in sort order, and two changes in one
 * second must keep theirs.
 */
export async function writeMigration(
  db: Database,
  dir: string,
  ops: MigrationOp[],
  now = new Date(),
): Promise<string> {
  const iso = now.toISOString(); // 2026-10-05T13:48:00.123Z
  const stamp = `${iso.slice(0, 19).replace(/[-:]/g, '')}-${iso.slice(20, 23)}`;
  const first = ops[0]!;
  const slug = [first.op, ...Object.values(first).slice(1)]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  let id = `${stamp}-${slug}`;
  for (let n = 2; existsSync(join(dir, 'migrations', `${id}.json`)); n++)
    id = `${stamp}-${slug}-${n}`;
  const file = { id, ops };
  writeFileSync(join(dir, 'migrations', `${id}.json`), serialize(file));
  await sql`INSERT INTO zv_schema_migrations (id, checksum)
            VALUES (${id}, ${migrationChecksum(file)})
            ON CONFLICT (id) DO NOTHING`.execute(db);
  return id;
}
