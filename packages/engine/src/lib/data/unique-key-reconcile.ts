/**
 * Every unique key on a collection table includes `tenant_id` — checked at each
 * boot, not once by a migration.
 *
 * Builds before this one wrote a `unique` field as a column-level `UNIQUE`, and
 * every collection table holds every tenant's rows: tenant B could not store a
 * value tenant A held, and the refusal confirmed the value existed in a row B
 * cannot see. The builders now write `UNIQUE (tenant_id, <field>)`
 * (`getUniqueKeyDDL`); this widens the keys already out there, and any that a
 * restored dump or a hand-run `ALTER` brings back later.
 *
 * Selected: a single-column unique constraint or unique index (not partial, not
 * an expression, not the primary key, not on `tenant_id`) on the table of a
 * managed, registered collection whose `tenant_id` is NOT NULL. Not touched:
 * extension-owned `zvd_*` tables (their keys are the extension's, often the
 * target of an `ON CONFLICT` a wider key would turn into 42P10), BYOD tables
 * (`is_managed = false`), and a key some foreign key references — that one
 * cannot be dropped (2BP01), so it is reported and left.
 *
 * Per key, without blocking writes for the length of a build: the new index is
 * built `CONCURRENTLY` outside any transaction, then one short transaction with
 * a lock timeout attaches it as the constraint and drops the old key. No row can
 * violate it: `(tenant_id, x)` is unique wherever `(x)` was.
 */
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { pgIdentifier } from '../pg-identifier.js';

export interface UniqueKeyReconcileResult {
  /** `<table>.<column>` whose key is now `(tenant_id, column)`. */
  fixed: string[];
  /** Keys left global, and why. Each is also printed as one warning. */
  skipped: { key: string; reason: string }[];
}

interface Candidate {
  tbl: string;
  col: string;
  old_index: string;
  old_constraint: string | null;
  referenced: boolean;
  widened: boolean;
}

/**
 * Returns null when another instance holds the lock — it is doing this work.
 *
 * Transaction-scoped, as `withExtensionLock` insists — a session lock leaked
 * onto a pooled connection once deadlocked every enable, and `db.connection()`
 * does not even pin one in this dialect (only a transaction reserves). The work
 * runs on the pool beside the holder: `CREATE INDEX CONCURRENTLY` refuses a
 * transaction. The holder idles in its transaction for as long as a build takes,
 * so it lifts the pool's `idle_in_transaction_session_timeout` for itself; it
 * holds no snapshot and no table lock, so the builds do not wait on it.
 */
export async function reconcileUniqueKeys(db: Database): Promise<UniqueKeyReconcileResult | null> {
  return db.transaction().execute(async (holder) => {
    await sql`SET LOCAL idle_in_transaction_session_timeout = 0`.execute(holder);
    const lock = await sql<{ ok: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtext('zveltio:unique-key-reconcile')) AS ok
    `.execute(holder);
    return lock.rows[0]?.ok ? reconcileLocked(db) : null;
  });
}

async function reconcileLocked(db: Database): Promise<UniqueKeyReconcileResult> {
  const result: UniqueKeyReconcileResult = { fixed: [], skipped: [] };
  const { rows } = await sql<Candidate>`
    SELECT c.relname AS tbl, a.attname AS col, ix.relname AS old_index,
           k.conname AS old_constraint,
           EXISTS (SELECT 1 FROM pg_constraint f
                    WHERE f.contype = 'f' AND f.conindid = i.indexrelid) AS referenced,
           EXISTS (SELECT 1 FROM pg_constraint w
                    WHERE w.conrelid = c.oid AND w.contype IN ('u', 'p')
                      AND w.conkey = ARRAY[t.attnum, a.attnum]) AS widened
      FROM zvd_collections zc
      JOIN pg_class c ON c.oid = to_regclass(quote_ident('zvd_' || zc.name))
      JOIN pg_attribute t ON t.attrelid = c.oid AND t.attname = 'tenant_id'
                         AND t.attnotnull AND NOT t.attisdropped
      JOIN pg_index i ON i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary
                     AND i.indisvalid AND i.indnatts = 1
                     AND i.indexprs IS NULL AND i.indpred IS NULL
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      JOIN pg_class ix ON ix.oid = i.indexrelid
      LEFT JOIN pg_constraint k ON k.conindid = i.indexrelid AND k.conrelid = c.oid
                               AND k.contype = 'u'
     WHERE a.attname <> 'tenant_id' AND zc.is_managed IS NOT FALSE
     ORDER BY 1, 2
  `.execute(db);

  for (const r of rows) {
    const key = `${r.tbl}.${r.col}`;
    const skip = (reason: string) => {
      result.skipped.push({ key, reason });
      console.warn(`⚠️  [unique-keys] ${key} keeps its tenant-wide unique key: ${reason}`);
    };
    if (r.referenced) {
      skip('a foreign key references it');
      continue;
    }
    // Postgres' own name for `UNIQUE (tenant_id, <col>)` — what the builders give
    // a new table — kept unique past 63 bytes.
    const name = pgIdentifier(`${r.tbl}_tenant_id_${r.col}_key`);
    try {
      // The per-tenant key may already sit beside the old one; then only drop.
      if (!r.widened) await buildIndex(db, r.tbl, r.col, name);
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        if (!r.widened) {
          await sql`
            ALTER TABLE ${sql.id(r.tbl)} ADD CONSTRAINT ${sql.id(name)} UNIQUE USING INDEX ${sql.id(name)}
          `.execute(trx);
        }
        await (r.old_constraint
          ? sql`ALTER TABLE ${sql.id(r.tbl)} DROP CONSTRAINT ${sql.id(r.old_constraint)}`
          : sql`DROP INDEX ${sql.id(r.old_index)}`
        ).execute(trx);
      });
      result.fixed.push(key);
    } catch (err) {
      skip(`${(err as { errno?: string }).errno ?? ''} ${(err as Error).message}`.trim());
    }
  }
  return result;
}

async function buildIndex(db: Database, tbl: string, col: string, name: string): Promise<void> {
  // A CONCURRENTLY build that died (cancelled, killed, lock timeout) leaves
  // an INVALID index that `IF NOT EXISTS` would happily keep.
  const prior = await sql<{ valid: boolean }>`
    SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(quote_ident(${name}))
  `.execute(db);
  if (prior.rows[0] && !prior.rows[0].valid) {
    await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(name)}`.execute(db);
  }
  await sql`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${sql.id(name)}
      ON ${sql.id(tbl)} (tenant_id, ${sql.id(col)})
  `.execute(db);
}
