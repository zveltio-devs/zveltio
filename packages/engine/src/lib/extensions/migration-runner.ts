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

/**
 * Refuse a migration that reshapes an engine table the extension does not own.
 *
 * Migrations run with `_sql.raw(...)` on the engine's own connection — as the
 * database owner — and they run in the MAIN THREAD, before the isolation
 * branch in `load.ts` chooses inline or worker. So the worker boundary, which
 * is the whole reason a community extension is allowed to install at all, does
 * not cover this path: an unreviewed extension gets owner-level DDL at install
 * time no matter what its manifest says about isolation.
 *
 * `buildAllowedTables` already decides which engine tables an extension may
 * touch at RUNTIME. This applies the same answer to DDL, which was the other
 * door and had no lock on it. Same allowlist, so the two cannot disagree.
 *
 * `zvd_*` is user data and always allowed — an extension that adds a column to
 * a collection is doing its job. `zv_<ext>_*` is its own namespace. Everything
 * else has to be named in `EXTENSION_TABLE_GRANTS`, which is a short list in
 * this repo changed by a pull request.
 *
 * Measured before writing: 187 ALTER statements across 13 extensions target an
 * engine table today, and all but one are tables those extensions own because
 * the feature moved out of the engine. They are already in the grants list. The
 * exception is `ai`, which relaxes a CHECK constraint on `zv_flows` so flows
 * can carry AI trigger types — legitimate, and now written down.
 */
async function assertMigrationTablesAllowed(extName: string, sqlText: string): Promise<void> {
  const { EXTENSION_TABLE_GRANTS, engineOwnedTables } = await import('./register.js');
  const { ownedPrefixFor } = await import('./worker-sql-policy.js');
  const engineTables = await engineOwnedTables();
  const granted = new Set((EXTENSION_TABLE_GRANTS[extName] ?? []).map((t) => t.toLowerCase()));
  const owned = ownedPrefixFor(extName).toLowerCase();

  const re = /\b(ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi;
  const offenders = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText)) !== null) {
    const table = m[2].toLowerCase();
    if (table.startsWith('zvd_') || table.startsWith(owned)) continue;
    if (granted.has(table)) continue;
    if (engineTables.has(table)) offenders.add(table);
  }

  if (offenders.size > 0) {
    throw new Error(
      `Extension "${extName}" has a migration that alters or drops engine table(s) ` +
        `${[...offenders].sort().join(', ')}. Migrations run as the database owner and ` +
        `before worker isolation is chosen, so this is the one place an extension can ` +
        `reshape the engine's own schema. Add the table to EXTENSION_TABLE_GRANTS if the ` +
        `extension genuinely owns it.`,
    );
  }
}

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
  // Checked before the transaction opens: a refusal should not leave a
  // half-applied chain behind, and the answer does not depend on the DB.
  for (const m of pending) {
    await assertMigrationTablesAllowed(extension.name, m.up);
  }

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
