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
import { type Database, recycleActivePool } from '../../db/index.js';
import {
  isNonTransactional,
  migrationTimeoutPreamble,
  splitSqlStatements,
} from '../../db/migrations/index.js';
import {
  ensureRlsEnforcementRole,
  noteReconcile,
  reconcileExtensionTenantRLS,
  reconcileFailures,
} from '../tenancy/index.js';
import { announcePoolRecycle } from '../runtime/index.js';
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

  // `ALTER TABLE [IF EXISTS] [ONLY] name` is valid Postgres — without the
  // `ONLY` allowance, `(\w+)` matched "ONLY" itself for `ALTER TABLE ONLY
  // <table> ...`, so the guard checked whether "only" was a protected table
  // (never true) instead of the real target and let the statement through.
  const re = /\b(ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi;
  const offenders = new Set<string>();
  /** Tables another extension is named the owner of: table -> those extensions. */
  const takenBy = new Map<string, string[]>();
  for (const m of sqlText.matchAll(re)) {
    const table = m[2].toLowerCase();
    if (table.startsWith('zvd_') || table.startsWith(owned)) continue;
    if (granted.has(table)) continue;
    if (engineTables.has(table)) {
      offenders.add(table);
      continue;
    }
    // Granted to somebody, just not to this extension.
    //
    // Without this branch, a table stops being protected the moment it stops
    // being the engine's. That is not hypothetical: moving a feature out of the
    // engine is exactly what this codebase is doing, and the check above reads
    // `engineOwnedTables()`, which is derived from the engine's own migration
    // files. So the same change that makes `zv_quality_scans` belong to
    // `analytics/quality` would also make it something ANY extension could
    // ALTER or DROP in its migrations, silently, on the way past.
    //
    // `EXTENSION_TABLE_GRANTS` already names the owner. Reading it in both
    // directions turns it from a permission into ownership, so a table can
    // leave the engine without leaving the fence. A table may legitimately have
    // several owners — `content/media` and `storage/cloud` share the media
    // library — and being one of them is what grants access.
    const owners = ownersOf(EXTENSION_TABLE_GRANTS, table);
    if (owners.length > 0) takenBy.set(table, owners);
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

  if (takenBy.size > 0) {
    const detail = [...takenBy.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, owners]) => `${table} (owned by ${owners.sort().join(', ')})`)
      .join(', ');
    throw new Error(
      `Extension "${extName}" has a migration that alters or drops ${detail}. ` +
        `These are not the engine's tables, so the engine-table check above does not ` +
        `cover them — EXTENSION_TABLE_GRANTS names another extension as the owner, and ` +
        `one extension must not reshape another's schema. If both genuinely own it, add ` +
        `"${extName}" to that table's grant; the media library is shared this way.`,
    );
  }
}

/** Every extension `EXTENSION_TABLE_GRANTS` names as an owner of `table`. */
function ownersOf(grants: Record<string, readonly string[]>, table: string): string[] {
  const out: string[] = [];
  for (const [ext, tables] of Object.entries(grants)) {
    if (tables.some((t) => t.toLowerCase() === table)) out.push(ext);
  }
  return out;
}

export async function runExtensionMigrations(
  extension: ZveltioExtension,
  db: Database,
  ownTables?: Set<string>,
): Promise<void> {
  const migrations = extension.getMigrations?.() || [];
  if (migrations.length === 0) return;
  // The loader passes the set it built; computing it again prints its
  // engine-table warning a second time.
  if (!ownTables) {
    const { buildAllowedTables } = await import('./register.js');
    ownTables = await buildAllowedTables(migrations, extension.name);
  }

  // A retry finds nothing to migrate, so nothing touched: without this the
  // extension refused for a permissive policy loaded on the second try. And a
  // restart forgets `unreconciled` — boot loads extensions before its own
  // reconcile, which only reports — so the policies on the extension's own
  // tables are read as well: one not on the host's predicate is owed too.
  const owed = new Set([
    ...(unreconciled.get(extension.name) ?? []),
    ...(await offPredicateTables(ownTables, db)),
  ]);
  if (owed.size > 0) await reconcileOrRefuse(extension.name, db, [...owed]);

  // Phase 1 — read all migrations + skip the ones already applied. Done
  // outside the outer transaction so an early-skipped chain (everything
  // already applied) doesn't open a useless transaction.
  const pending: Pending[] = [];
  for (const migrationPath of migrations) {
    const name = `ext:${extension.name}:${migrationPath.split('/').pop()?.replace('.sql', '')}`;
    // "Already applied?" — and `null` means "no, run it". A `.catch(() => null)`
    // here therefore re-ran an extension's migration whenever the question could not
    // be answered, which is only safe while every extension's SQL happens to be
    // idempotent. A seed INSERT or a backfill is not.
    const existing = await db
      .selectFrom('zv_migrations')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    if (existing) continue;

    const rawSql = await Bun.file(migrationPath).text();
    const { up, down } = parseMigrationSql(rawSql);
    pending.push({ name, up, down });
  }

  if (pending.length === 0) return;

  // Checked before anything runs: a refusal should not leave a half-applied
  // chain behind, and the answer does not depend on the DB.
  for (const m of pending) {
    await assertMigrationTablesAllowed(extension.name, m.up);
  }

  // Phase 2 — run the chain in as few transactions as its contents allow.
  //
  // The default is still one transaction for the whole chain: if any UP fails,
  // Postgres rolls back everything (DDL is transactional for CREATE TABLE /
  // ALTER / DROP / most CREATE INDEX variants), so an extension either installs
  // or does not, with nothing in between.
  //
  // A migration marked `-- NO TRANSACTION` cannot join that, because the one
  // thing the marker is for — `CREATE INDEX CONCURRENTLY` — is illegal inside
  // a transaction block. Rather than refuse the marker, the chain is cut into
  // runs of consecutive transactional migrations, each still atomic, with the
  // marked ones executed alone and outside. An extension that never uses the
  // marker is unaffected: one segment, one transaction, exactly as before.
  //
  // What is genuinely given up: if a later segment fails, earlier segments are
  // already committed. That is inherent — a concurrent index build cannot be
  // rolled back by a transaction that does not contain it — and it is why the
  // marker is opt-in and why the linter demands `IF NOT EXISTS` throughout a
  // marked migration. The migration row is written only after its own UP
  // succeeds, so a failed run is retried whole on the next boot.
  const policiesBefore = await tenantIsolationPolicies(db);

  const segments: Segment[] = [];
  for (const m of pending) {
    const transactional = !isNonTransactional(m.up);
    const last = segments[segments.length - 1];
    if (last && last.transactional && transactional) last.items.push(m);
    else segments.push({ transactional, items: [m] });
  }

  // Reconciled whether or not a segment throws: one that fails after an earlier
  // segment committed leaves that segment's policies in force, and only this
  // rewrites them before the next boot.
  try {
    await runSegments(segments, db);
  } catch (err) {
    await reconcileTouched(extension.name, db, policiesBefore).catch((e: Error) =>
      console.warn(
        `[tenant-rls] ${extension.name}: reconcile after a failed migration:`,
        e.message,
      ),
    );
    throw err;
  } finally {
    // An UP may reshape an engine table (`ai` adds columns to `zvd_collections`),
    // and every pooled connection that prepared a `SELECT *` over it then fails
    // it with 0A000 — a 500 inside a request transaction — until it is replaced.
    // Here, not at the boot call site alone: an enable or upgrade on a running
    // engine reaches this too.
    await dropStalePlans();
  }
  await reconcileTouched(extension.name, db, policiesBefore);
  // A table just created holds the request role's default DML grant (001) until
  // the next boot; take back what boot takes back (zvd_validation_rule_groups).
  await ensureRlsEnforcementRole(db);
  // ...and a sealed collection table the UP re-created holds table-level SELECT
  // from the same default grant, sealed columns included, which the call above
  // keeps (it only narrows a table already held column by column). Boot reseals
  // after it; so does this. Dynamic import: lib/data reaches back into here.
  const { reconcileSealedColumns } = await import('../data/index.js');
  await reconcileSealedColumns(db);
}

type Pending = { name: string; up: string; down: string | null };
type Segment = { transactional: boolean; items: Pending[] };

async function runSegments(segments: Segment[], db: Database): Promise<void> {
  for (const segment of segments) {
    if (segment.transactional) {
      await db.transaction().execute(async (trx) => {
        // Same lock_timeout / statement_timeout as the engine's own migrations.
        for (const stmt of migrationTimeoutPreamble()) await _sql.raw(stmt).execute(trx);
        for (const m of segment.items) {
          await _sql.raw(m.up).execute(trx);
          // Persist DOWN alongside the migration row so a future uninstall with
          // purgeData=true can replay rollbacks without the original files.
          await trx
            .insertInto('zv_migrations')
            .values({ name: m.name, down_sql: m.down })
            .execute();
          console.log(`  ✓ Extension migration: ${m.name}`);
        }
      });
      continue;
    }

    for (const m of segment.items) {
      // Statement by statement, not as one raw blob. A multi-statement simple
      // query is itself an implicit transaction block, so sending the whole UP
      // at once would have Postgres reject CONCURRENTLY just as surely as the
      // explicit transaction this path exists to escape.
      for (const stmt of splitSqlStatements(m.up)) {
        await _sql.raw(stmt).execute(db);
      }
      await db.insertInto('zv_migrations').values({ name: m.name, down_sql: m.down }).execute();
      console.log(`  ✓ Extension migration (no transaction): ${m.name}`);
    }
  }
}

/** Per extension, the tables its last run could not put on the host's predicate. */
const unreconciled = new Map<string, string[]>();

/**
 * Extension templates put the READ predicate (`zveltio_tenant_scope_ok`, a
 * whole subtree for a consolidating parent) in WITH CHECK, which lets a parent
 * write into a child's rows. The boot reconciler rewrites that, but an install
 * or enable at run time used to keep it until the next restart. Only the
 * policies this run created or changed are touched.
 */
async function reconcileTouched(
  extName: string,
  db: Database,
  policiesBefore: Map<string, string>,
): Promise<void> {
  const policiesAfter = await tenantIsolationPolicies(db);
  const touched = [...policiesAfter]
    .filter(([table, def]) => policiesBefore.get(table) !== def)
    .map(([table]) => table);
  if (touched.length > 0) await reconcileOrRefuse(extName, db, touched);
}

/**
 * Rewrite `tables`' policies, or refuse the load. It was best-effort, so a table
 * the rewrite failed on kept the template's WITH CHECK and the extension loaded
 * on it. A refusal names the tables; `/health` reports them (`tenant_rls`).
 */
async function reconcileOrRefuse(extName: string, db: Database, tables: string[]): Promise<void> {
  await reconcileExtensionTenantRLS(db, tables);
  const failed = reconcileFailures('ext_tenant_rls').filter((f) => tables.includes(f.table));
  if (failed.length === 0) {
    unreconciled.delete(extName);
    return;
  }
  unreconciled.set(
    extName,
    failed.map((f) => f.table),
  );
  for (const f of failed) noteReconcile('ext_tenant_rls', f.table, `${extName}: ${f.error}`);
  throw new Error(
    `Extension "${extName}": tenant isolation could not be applied to ` +
      `${failed.map((f) => `${f.table} (${f.error})`).join(', ')}. Its own policy would let a ` +
      `parent tenant write into a child's rows, so the extension is not loaded; the next load ` +
      `retries it.`,
  );
}

/**
 * The extension's tables (`ownTables`, from `buildAllowedTables`), so third-party
 * extensions too — whose `tenant_isolation_*` policy is not the one
 * `reconcileExtensionTenantRLS` writes. On a settled install: none, no DDL.
 */
async function offPredicateTables(ownTables: Set<string>, db: Database): Promise<string[]> {
  const own = [...ownTables].map((t) => t.toLowerCase());
  const rows = await _sql<{ t: string }>`
    SELECT DISTINCT tablename AS t
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname LIKE 'tenant\\_isolation\\_%'
       AND lower(tablename) = ANY(${own}::text[])
       AND coalesce(with_check, '') <> 'zveltio_tenant_write_ok(tenant_id)'
  `.execute(db);
  return rows.rows.map((r) => r.t);
}

/** `tenant_isolation_*` policies per table, as text, to tell which a run changed. */
async function tenantIsolationPolicies(db: Database): Promise<Map<string, string>> {
  const rows = await _sql<{ t: string; def: string }>`
    SELECT tablename AS t,
           string_agg(policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''),
                      ';' ORDER BY policyname) AS def
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname LIKE 'tenant\\_isolation\\_%'
     GROUP BY tablename
  `.execute(db);
  return new Map(rows.rows.map((r) => [r.t, r.def]));
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
  // No `.catch(() => [])` here.
  //
  // This is the rollback path. An empty list means "this extension has no
  // migrations to undo", and two lines down that returns immediately — so a read
  // failure used to make an uninstall drop nothing and report success, leaving
  // every table the extension created behind while the registry says it is gone.
  const rows = await db
    .selectFrom('zv_migrations')
    .select(['id', 'name', 'down_sql'])
    .where('name', 'like', `${prefix}%`)
    .orderBy('id', 'desc')
    .execute();

  if (rows.length === 0) return;

  const missing = rows.filter((r) => !r.down_sql || r.down_sql.trim() === '');
  if (missing.length > 0) {
    throw new DownMissingError(
      extensionName,
      missing.map((r) => r.name),
    );
  }

  await db.transaction().execute(async (trx) => {
    // The UP path's lock_timeout: a DROP behind one long reader otherwise waits
    // at the head of the lock queue with the table's traffic stalled behind it.
    for (const stmt of migrationTimeoutPreamble()) await _sql.raw(stmt).execute(trx);
    for (const r of rows) {
      const downSql = r.down_sql as string;
      await _sql.raw(downSql).execute(trx);
      await trx.deleteFrom('zv_migrations').where('id', '=', r.id).execute();
      console.log(`  ✓ Extension purge: rolled back ${r.name}`);
    }
  });
  // A DOWN reshapes what its UP did: see `runExtensionMigrations`.
  await dropStalePlans();
}

/**
 * Here and on every other instance sharing the database: theirs hold the same
 * stale plans, and nothing else tells them a migration ran.
 */
async function dropStalePlans(): Promise<void> {
  await recycleActivePool();
  announcePoolRecycle();
}
