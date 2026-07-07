/**
 * Extension migration runner — apply / roll back an extension's SQL migrations.
 *
 * Extracted from `extension-loader.ts` (H-04 split). These are pure functions —
 * they take an explicit `db` and never touch loader state — so they live here
 * rather than as `ExtensionLoader` methods. The loader keeps thin delegating
 * methods for call-site compatibility (`this.runExtensionMigrations`,
 * `extensionLoader.purgeExtensionData`).
 */

import { sql as _sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { DownMissingError } from './extension-errors.js';
import { parseMigrationSql } from './extension-utils.js';

/**
 * Apply this extension's not-yet-applied SQL migrations in a single outer
 * transaction, persisting each migration's DOWN alongside its `zv_migrations`
 * row so a later purge can roll back without the original files.
 */
export async function runExtensionMigrations(
  extension: ZveltioExtension,
  db: Database,
): Promise<void> {
  const migrations = extension.getMigrations?.() || [];
  if (migrations.length === 0) return;

  // Phase 1 — read all migrations + skip the ones already applied. Done
  // outside the outer transaction so an early-skipped chain (everything
  // already applied) doesn't open a useless transaction.
  type Pending = { name: string; up: string; down: string | null };
  const pending: Pending[] = [];
  for (const migrationPath of migrations) {
    const name = `ext:${extension.name}:${migrationPath.split('/').pop()?.replace('.sql', '')}`;
    const existing = await db
      .selectFrom('zv_migrations')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst()
      .catch(() => null);
    if (existing) continue;

    const rawSql = await Bun.file(migrationPath).text();
    const { up, down } = parseMigrationSql(rawSql);
    pending.push({ name, up, down });
  }

  if (pending.length === 0) return;

  // Phase 2 — run the entire chain in ONE outer transaction. If any UP
  // fails, Postgres rolls back the whole chain (DDL is transactional for
  // CREATE TABLE / ALTER / DROP / most CREATE INDEX variants). Migrations
  // that need CONCURRENTLY or other non-transactional DDL cannot use this
  // path — they must be expressed differently (e.g. split into a separate
  // non-extension migration applied by an admin).
  await db.transaction().execute(async (trx) => {
    for (const m of pending) {
      await _sql.raw(m.up).execute(trx);
      // Persist DOWN alongside the migration row so a future uninstall with
      // purgeData=true can replay rollbacks without the original files.
      await trx.insertInto('zv_migrations').values({ name: m.name, down_sql: m.down }).execute();
      console.log(`  ✓ Extension migration: ${m.name}`);
    }
  });
}

/**
 * Reverse-apply every migration this extension has on record, in reverse
 * order, then delete the zv_migrations rows. The whole operation runs in a
 * single transaction — if any DOWN fails the chain is rolled back.
 *
 * Throws DownMissingError listing the migrations that have no DOWN section.
 * In that case nothing is dropped — the operator can either run those DOWNs
 * manually or accept that purge cannot proceed.
 */
export async function purgeExtensionData(extensionName: string, db: Database): Promise<void> {
  const prefix = `ext:${extensionName}:`;
  const rows = await db
    .selectFrom('zv_migrations')
    .select(['id', 'name', 'down_sql'])
    .where('name', 'like', `${prefix}%`)
    .orderBy('id', 'desc')
    .execute()
    .catch(() => []);

  if (rows.length === 0) return;

  const missing = rows.filter((r) => !r.down_sql || r.down_sql.trim() === '');
  if (missing.length > 0) {
    throw new DownMissingError(
      extensionName,
      missing.map((r) => r.name),
    );
  }

  await db.transaction().execute(async (trx) => {
    for (const r of rows) {
      const downSql = r.down_sql as string;
      await _sql.raw(downSql).execute(trx);
      await trx.deleteFrom('zv_migrations').where('id', '=', r.id).execute();
      console.log(`  ✓ Extension purge: rolled back ${r.name}`);
    }
  });
}
