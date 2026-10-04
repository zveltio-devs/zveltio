/**
 * The composite tenant indexes, built after the server listens.
 *
 * `applyTenantRLS` gives every collection table `(tenant_id, created_at DESC)`
 * for paginated lists and `(tenant_id, updated_at, id::text COLLATE "C")` for
 * the sync pull's keyset, and `reconcileExtensionTenantRLS` gives policed
 * extension tables the first. At boot those were plain CREATE INDEX statements
 * run before `Bun.serve`: on an existing large table one blocks its writers for
 * the whole build (about 0.6 µs a row, seconds at ten million) while the server
 * is not serving at all, and a readiness probe can restart it mid-build. The
 * boot reconcilers now leave them here, the shape `reconcileUniqueKeys` already
 * has: under an advisory lock, so replicas booting together build each index
 * once, and CONCURRENTLY, so writers carry on. Until an index exists the reads
 * that want it are slower, never wrong.
 */
import { sql } from 'kysely';
import { tryAdvisoryLock } from '../../db/advisory-lock.js';
import type { Database } from '../../db/index.js';
import { indexName } from '../pg-identifier.js';

export interface TenantIndexReconcileResult {
  /** Indexes built, as their names. */
  built: string[];
  /** Indexes that could not be built, and why. Each is also one warning. */
  failed: { index: string; reason: string }[];
}

interface Wanted {
  table: string;
  index: string;
  columns: string;
}

/** Policed tables with a `tenant_id`, and the composites each one is owed. */
async function wantedIndexes(db: Database): Promise<Wanted[]> {
  const { rows } = await sql<{
    table: string;
    collection: boolean;
    created: boolean;
    updated: boolean;
  }>`
    SELECT c.relname AS table,
           (c.relname LIKE 'zvd\\_%' AND EXISTS (
              SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
           )) AS collection,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                     AND a.attname = 'created_at' AND NOT a.attisdropped) AS created,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                     AND a.attname = 'updated_at' AND NOT a.attisdropped) AS updated
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                     AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                     AND (p.polname = 'tenant_isolation' OR p.polname LIKE 'tenant\\_isolation\\_%'))
     ORDER BY 1
  `.execute(db);
  const wanted: Wanted[] = [];
  for (const r of rows) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(r.table)) continue;
    if (r.created) {
      wanted.push({
        table: r.table,
        index: indexName(r.table, 'tenant_created'),
        columns: '(tenant_id, created_at DESC)',
      });
    }
    // The sync pull reads collections only.
    if (r.collection && r.updated) {
      wanted.push({
        table: r.table,
        index: indexName(r.table, 'tenant_updated'),
        columns: '(tenant_id, updated_at, (id::text COLLATE "C"))',
      });
    }
  }
  return wanted;
}

/** Build every missing or INVALID composite. Null when another instance holds the lock. */
export async function reconcileTenantIndexes(
  db: Database,
): Promise<TenantIndexReconcileResult | null> {
  return tryAdvisoryLock(db, 'zveltio:tenant-index-reconcile', () => reconcileLocked(db));
}

async function reconcileLocked(db: Database): Promise<TenantIndexReconcileResult> {
  const result: TenantIndexReconcileResult = { built: [], failed: [] };
  for (const w of await wantedIndexes(db)) {
    try {
      const prior = await sql<{ valid: boolean }>`
        SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(quote_ident(${w.index}))
      `.execute(db);
      if (prior.rows[0]?.valid) continue;
      // A CONCURRENTLY build that died (cancelled, killed, a restart) leaves an
      // INVALID index that `IF NOT EXISTS` would keep for good.
      if (prior.rows[0]) {
        await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(w.index)}`.execute(db);
      }
      await sql`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS ${sql.id(w.index)}
          ON ${sql.id(w.table)} ${sql.raw(w.columns)}
      `.execute(db);
      result.built.push(w.index);
    } catch (err) {
      const reason = `${(err as { errno?: string }).errno ?? ''} ${(err as Error).message}`.trim();
      result.failed.push({ index: w.index, reason });
      console.warn(`⚠️  [tenant-indexes] ${w.index} not built: ${reason}`);
    }
  }
  return result;
}
