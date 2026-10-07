/**
 * Ghost DDL — Zero-Downtime Schema Migrations
 *
 * GitHub/PlanetScale algorithm: Ghost Table + Trigger Changelog + Batch Copy + Atomic Swap
 *
 * Steps:
 *   1. createGhost  — Creates ghost table (identical structure + DDL changes applied)
 *                     + changelog table + trigger that captures live mutations
 *   2. batchCopy    — Copies existing data in batches (cursor-based, 10k/batch)
 *   3. applyChangelog — Applies accumulated changelog mutations to ghost table
 *   4. atomicSwap   — Short LOCK + atomic RENAME: original → old, ghost → original
 *                     Reads continue during LOCK, only writes are blocked for a few ms.
 */

import type { Database } from '../../db/index.js';
import { sql } from 'kysely';
import { publishEveryTenant } from '../tenancy/index.js';
import { pgIdentifier } from '../pg-identifier.js';
import { SYSTEM_COLUMNS } from './ddl-manager.js';
import { type FieldConfig, fieldTypeRegistry } from './field-type-registry.js';

const BATCH_SIZE = 10_000;

// Track pending cleanup timers so they can be cancelled at shutdown
const _pendingCleanups = new Map<ReturnType<typeof setTimeout>, () => Promise<void>>();

/** Cancel all pending Ghost DDL cleanup timers (call on graceful shutdown). */
export function cancelPendingCleanups(): void {
  for (const timer of _pendingCleanups.keys()) clearTimeout(timer);
  _pendingCleanups.clear();
}

/**
 * Cancel the pending cleanups and hand them back, for a test to run when it
 * chooses. Test-only.
 *
 * The test that needed one replaced `globalThis.setTimeout` to catch it, and
 * `bun test` runs every harness file in one process: every timer anything else
 * set in that window was swallowed too, among them each pg-boss worker's poll
 * delay, so that worker never polled again and every later DDL job sat queued
 * until its test timed out (Handler Coverage, since 2026-09-30).
 */
export function _takePendingCleanupsForTests(): Array<() => Promise<void>> {
  const runs = [..._pendingCleanups.values()];
  cancelPendingCleanups();
  return runs;
}

export interface GhostMigration {
  originalTable: string;
  ghostTable: string;
  changelogTable: string;
  triggerName: string;
  /**
   * The ghost's outbound foreign keys, detached for the copy and re-added at the
   * swap: `add` runs inside the swap transaction, `validate` after it commits.
   */
  foreignKeys?: { add: string; validate: string }[];
  /**
   * Each ghost index paired with the original index it was copied from. `LIKE`
   * names the copies after the ghost table, and the table rename does not
   * rename them; the swap gives each back its original name.
   */
  indexes?: { ghost: string; original: string }[];
  /**
   * Which original column fills each ghost column, by name. The copy and the
   * changelog replay both go through it: positions shift under a DROP COLUMN and
   * names change under a RENAME, and a column the DDL added has no source here.
   */
  columns: { ghost: string; original: string }[];
}

/** Non-dropped, non-generated columns of `table`, by attnum. */
async function liveColumns(
  db: Database,
  table: string,
): Promise<{ attnum: number; attname: string }[]> {
  const r = await sql<{ attnum: number; attname: string }>`
    SELECT attnum::int AS attnum, attname::text AS attname FROM pg_attribute
    WHERE attrelid = to_regclass(quote_ident(${table}))
      AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
    ORDER BY attnum
  `.execute(db);
  return r.rows;
}

/**
 * A transaction that reads every tenant's rows while staying the table owner.
 *
 * In production the engine owns the collection tables and FORCE RLS binds it,
 * so the bare pool reads a policed table as the default tenant only. A copy made
 * that way held one tenant's rows, the swap committed it, and the post-swap DROP
 * of the old copy made every other tenant's rows unrecoverable.
 */
function inEveryTenant<T>(db: Database, fn: (trx: Database) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await publishEveryTenant(trx);
    return fn(trx);
  });
}

/**
 * What `CREATE TABLE … (LIKE … INCLUDING ALL)` does not copy, as statements that
 * recreate it on the ghost once the ghost has taken the original's name.
 *
 * Read from the catalog inside the swap transaction, under the lock, so a policy
 * or trigger changed while the copy ran is carried in its current form. Every
 * statement is built by Postgres (`format('%I')`, `pg_get_triggerdef`,
 * `pg_get_expr`) and names the table by the original's name, which at execution
 * time is the ghost's. The grants are mirrored exactly — REVOKE what the ghost
 * got from default privileges, then GRANT what the original held — because a
 * privilege revoked on the original would otherwise come back.
 *
 * `step >= 100` is the post-commit half: validating the re-pointed inbound
 * foreign keys, which are re-added NOT VALID so the lock never waits on a scan.
 */
async function carriedOverDdl(
  db: Database,
  table: string,
  ghost: string,
  changelogTrigger: string,
): Promise<{ step: number; ddl: string }[]> {
  const r = await sql<{ step: number; ddl: string }>`
    WITH o AS (
      SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity,
             coalesce(c.relacl, acldefault('r', c.relowner)) AS acl
      FROM pg_class c WHERE c.oid = to_regclass(quote_ident(${table}))
    ), g AS (
      SELECT coalesce(c.relacl, acldefault('r', c.relowner)) AS acl
      FROM pg_class c WHERE c.oid = to_regclass(quote_ident(${ghost}))
    ), inbound AS (
      SELECT k.* FROM o JOIN pg_constraint k
        ON k.confrelid = o.oid AND k.conrelid <> o.oid AND k.contype = 'f'
    )
    SELECT 1 AS step, format('REVOKE ALL ON %I FROM %s', o.relname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END) AS ddl
      FROM o, g, aclexplode(g.acl) a GROUP BY o.relname, a.grantee
    UNION ALL
    SELECT 2, format('ALTER TABLE %I OWNER TO %I', o.relname, pg_get_userbyid(o.relowner)) FROM o
    UNION ALL
    SELECT 3, format('GRANT %s ON %I TO %s%s', a.privilege_type, o.relname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
             CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
      FROM o, aclexplode(o.acl) a
    UNION ALL
    SELECT 4, format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', o.relname) FROM o WHERE o.relrowsecurity
    UNION ALL
    SELECT 4, format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', o.relname) FROM o WHERE o.relforcerowsecurity
    UNION ALL
    SELECT 5, format('CREATE POLICY %I ON %I AS %s FOR %s TO %s%s%s', p.polname, o.relname,
             CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
             CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                           WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
             (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r)) END, ', ')
                FROM unnest(p.polroles) r),
             ' USING (' || pg_get_expr(p.polqual, p.polrelid) || ')',
             ' WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')')
      FROM o JOIN pg_policy p ON p.polrelid = o.oid
    UNION ALL
    SELECT 6, pg_get_triggerdef(t.oid)
      FROM o JOIN pg_trigger t ON t.tgrelid = o.oid
      WHERE NOT t.tgisinternal AND t.tgname <> ${changelogTrigger}
    UNION ALL
    SELECT 7, format('ALTER TABLE %I %s TRIGGER %I', o.relname,
             CASE t.tgenabled WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE ALWAYS' END,
             t.tgname)
      FROM o JOIN pg_trigger t ON t.tgrelid = o.oid
      WHERE NOT t.tgisinternal AND t.tgname <> ${changelogTrigger} AND t.tgenabled <> 'O'
    UNION ALL
    -- Inbound foreign keys are bound to the original by oid, so after the rename
    -- they would guard the old copy and pin it against the post-swap DROP.
    SELECT 8, format('ALTER TABLE %s DROP CONSTRAINT %I', k.conrelid::regclass, k.conname) FROM inbound k
    UNION ALL
    SELECT 9, format('ALTER TABLE %s ADD CONSTRAINT %I %s%s', k.conrelid::regclass, k.conname,
             pg_get_constraintdef(k.oid), CASE WHEN k.convalidated THEN ' NOT VALID' ELSE '' END)
      FROM inbound k
    UNION ALL
    SELECT 100, format('ALTER TABLE %s VALIDATE CONSTRAINT %I', k.conrelid::regclass, k.conname)
      FROM inbound k WHERE k.convalidated
    ORDER BY step
  `.execute(db);
  return r.rows;
}

/**
 * What a ghost migration may change. GhostDDL builds the SQL itself — the column
 * from the field-type registry, every name quoted — so a change it does not
 * model has no spelling: there is no operation that drops `tenant_id` or adds a
 * CHECK.
 *
 * This replaced a regex over caller-written `ALTER TABLE` fragments. Its type
 * part had to admit commas and keywords (`NUMERIC(10,2)`, `NOT NULL DEFAULT …`),
 * so `ADD COLUMN x text, DROP COLUMN tenant_id` and `ADD COLUMN x text, ADD
 * CONSTRAINT evil CHECK (true)` both passed it.
 *
 * There is no ALTER COLUMN: nothing sends one, and a free-form tail is what
 * made the regex unsafe.
 */
export type GhostOperation =
  /**
   * The column a field defines, with the `UNIQUE (tenant_id, <field>)` key a
   * `unique` field has — built on the ghost, so nothing is indexed under the
   * swap's lock. Only a column born in this run takes a key: the copy and the
   * replay never write it (the original has no such column), so it holds only
   * its default and no write made during the copy can trip the key. A key over
   * an existing column would replay the original's intermediate states, which
   * no key ever checked.
   */
  | { kind: 'add_column'; field: FieldConfig }
  | { kind: 'drop_column'; column: string }
  | { kind: 'rename_column'; from: string; to: string };

/** A column name an operation may touch: an identifier, and not a system column. */
function userColumn(name: unknown): string {
  if (
    typeof name !== 'string' ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
    name.length > 63 ||
    SYSTEM_COLUMNS.has(name)
  ) {
    throw new Error(`[ghost-ddl] refusing column ${JSON.stringify(name)}: not a user column`);
  }
  return name;
}

/** The statements one operation runs on the ghost of `table`. */
function operationDdl(table: string, ghost: string, op: GhostOperation) {
  const g = sql.id(ghost);
  switch (op?.kind) {
    case 'add_column': {
      const name = userColumn(op.field?.name);
      const column = fieldTypeRegistry.getColumnDDL(op.field);
      if (!column) throw new Error(`[ghost-ddl] field "${name}" is virtual: it has no column`);
      const out = [sql`ALTER TABLE ${g} ADD COLUMN ${sql.raw(column)}`];
      const key = fieldTypeRegistry.getUniqueKeyDDL(op.field);
      // Named after the table it ends up on — up to 63 bytes, the name Postgres
      // gives the same key added to the original — not after the ghost.
      const keyName = pgIdentifier(`${table}_tenant_id_${name}_key`);
      if (key) out.push(sql`ALTER TABLE ${g} ADD CONSTRAINT ${sql.id(keyName)} ${sql.raw(key)}`);
      return out;
    }
    case 'drop_column':
      return [sql`ALTER TABLE ${g} DROP COLUMN ${sql.id(userColumn(op.column))}`];
    case 'rename_column':
      return [
        sql`ALTER TABLE ${g} RENAME COLUMN ${sql.id(userColumn(op.from))} TO ${sql.id(userColumn(op.to))}`,
      ];
    default:
      throw new Error(`[ghost-ddl] unknown operation: ${JSON.stringify(op)}`);
  }
}

// raw-ident-ok-file: every identifier this module interpolates is derived from
// the `tableName` that `createGhost` validates against /^[a-zA-Z_][a-zA-Z0-9_]*$/
// before building anything from it — the ghost table, the changelog table, the
// trigger and its function are all that name plus a literal prefix, and the
// `migration` record carried between steps holds those same four strings.
//
// The other `sql.raw` inputs are statements Postgres itself built from the
// catalog (`format('%I')`, `pg_get_*def`) — see carriedOverDdl — and the
// column and key DDL of `operationDdl`, which the field-type registry builds
// from a name `userColumn` has validated.
//
// Whole-file rather than nineteen separate annotations: this is one pipeline
// from one input, and marking each statement would say the same sentence
// nineteen times.

export class GhostDDL {
  /**
   * STEP 1: Creates ghost table identical to original + applies DDL changes on it.
   * Also creates changelog table + trigger that captures INSERT/UPDATE/DELETE live.
   */
  static async createGhost(
    db: Database,
    tableName: string,
    operations: GhostOperation[],
  ): Promise<GhostMigration> {
    // Validated here rather than trusted from the caller. Four identifiers are
    // derived from this one string and every one is interpolated into a
    // `sql.raw` template below, so a name carrying a double quote would escape
    // the identifier and land arbitrary SQL inside a DDL statement.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`Unsafe table name for ghost migration: "${tableName}"`);
    }

    const ghost = `_zv_ghost_${tableName}`;
    // Every operation is built before anything is created: one that cannot be
    // leaves nothing behind.
    const ddl = operations.flatMap((op) => operationDdl(tableName, ghost, op));
    const changelog = `_zv_changelog_${tableName}`;
    const triggerFn = `_zv_trg_ghost_${tableName}_fn`;
    const trigger = `_zv_trg_ghost_${tableName}`;

    // 1. Create ghost table with same structure (including indexes, constraints)
    await sql`CREATE TABLE ${sql.id(ghost)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(db);
    // Named as the original's columns until the DDL runs; an attnum survives a
    // RENAME or a type change, so this is what maps the two afterwards.
    const born = new Map((await liveColumns(db, ghost)).map((c) => [c.attnum, c.attname]));
    // Paired while both tables still have the same columns, so an index and its
    // copy have the same definition. Identical duplicates pair in oid order;
    // which of two identical indexes gets which name makes no difference.
    const indexes = await sql<{ ghost: string; original: string }>`
      WITH ix AS (
        SELECT i.indrelid, c.relname::text AS name,
               row_number() OVER (
                 PARTITION BY i.indrelid, c.relam, i.indkey::text, i.indclass::text,
                              i.indoption::text, i.indisunique, i.indisprimary,
                              pg_get_expr(i.indexprs, i.indrelid), pg_get_expr(i.indpred, i.indrelid)
                 ORDER BY i.indexrelid) AS n,
               concat_ws('|', c.relam, i.indkey::text, i.indclass::text, i.indoption::text,
                         i.indisunique, i.indisprimary,
                         pg_get_expr(i.indexprs, i.indrelid), pg_get_expr(i.indpred, i.indrelid)) AS def
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid IN (to_regclass(quote_ident(${tableName})), to_regclass(quote_ident(${ghost})))
      )
      SELECT g.name AS ghost, o.name AS original
      FROM ix o JOIN ix g ON g.def = o.def AND g.n = o.n
      WHERE o.indrelid = to_regclass(quote_ident(${tableName}))
        AND g.indrelid = to_regclass(quote_ident(${ghost}))
    `.execute(db);

    // LIKE copies no foreign keys. Attached BEFORE the DDL (NOT VALID, on an
    // empty table: instant) so a DROP or RENAME COLUMN removes or follows them
    // exactly as it would on the original.
    const outbound = await sql<{ ddl: string }>`
      SELECT format('ALTER TABLE %I ADD CONSTRAINT %I %s%s', ${ghost}::text, k.conname,
               pg_get_constraintdef(k.oid), CASE WHEN k.convalidated THEN ' NOT VALID' ELSE '' END) AS ddl
      FROM pg_constraint k
      WHERE k.conrelid = to_regclass(quote_ident(${tableName})) AND k.contype = 'f'
    `.execute(db);
    for (const { ddl } of outbound.rows) await sql.raw(ddl).execute(db);

    // 2. Apply the operations on the ghost — see GhostOperation.
    for (const statement of ddl) await statement.execute(db);

    // …and detached again for the copy, which inserts in id order and would
    // trip a self-reference to a row not yet copied. Re-added at the swap.
    const fks = await sql<{ name: string; add: string; validate: string }>`
      SELECT k.conname AS name,
             format('ALTER TABLE %I ADD CONSTRAINT %I %s', ${tableName}::text, k.conname,
               pg_get_constraintdef(k.oid)) AS add,
             format('ALTER TABLE %I VALIDATE CONSTRAINT %I', ${tableName}::text, k.conname) AS validate
      FROM pg_constraint k
      WHERE k.conrelid = to_regclass(quote_ident(${ghost})) AND k.contype = 'f'
    `.execute(db);
    for (const { name } of fks.rows) {
      await sql`ALTER TABLE ${sql.id(ghost)} DROP CONSTRAINT ${sql.id(name)}`.execute(db);
    }

    const columns = (await liveColumns(db, ghost)).flatMap((c) => {
      const original = born.get(c.attnum);
      return original === undefined ? [] : [{ ghost: c.attname, original }];
    });

    // 3. Changelog table — captures all mutations during batch copy.
    // One by this name can only be a finished run's, still waiting for its
    // post-swap cleanup: a run in progress holds the ghost table, and this
    // run's CREATE of that just succeeded. Left in place, it failed every
    // second migration of a table within a minute of the first — a
    // schema-branch merge touching two fields of the same large table.
    await sql`DROP TABLE IF EXISTS ${sql.id(changelog)}`.execute(db);
    await sql`
      CREATE TABLE ${sql.id(changelog)} (
        id        BIGSERIAL PRIMARY KEY,
        operation TEXT      NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
        row_id    TEXT      NOT NULL,
        row_data  JSONB,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    // Every tenant's rows land here with no RLS, and default privileges (001)
    // hand `zveltio_rls` DML on it at CREATE. Only the owner needs it: the
    // trigger below writes as owner, and the engine replays it as owner.
    const grants = await sql<{ ddl: string }>`
      SELECT format('REVOKE ALL ON %s FROM %s', c.oid::regclass,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END) AS ddl
        FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.oid IN (to_regclass(quote_ident(${changelog})),
                       pg_get_serial_sequence(quote_ident(${changelog}), 'id')::regclass)
         AND a.grantee <> c.relowner
       GROUP BY c.oid, a.grantee
    `.execute(db);
    for (const { ddl } of grants.rows) await sql.raw(ddl).execute(db);

    // 4. Trigger function + trigger on original table
    //    Any write to original while we copy is saved to changelog.
    //
    // SECURITY DEFINER: the writer is `zveltio_ext` or `zveltio_worker`, which
    // hold the collection and not the changelog, so as INVOKER every extension
    // write to the table failed `permission denied` for as long as the copy ran
    // (tests/harness/restricted-role-triggers.test.ts). Safe to run as owner:
    // every identifier is fixed here from the validated name, and the row only
    // ever reaches the changelog as data. pg_temp last, or a writer's temp table
    // named like the changelog would capture the owner's INSERT.
    await sql
      .raw(
        `
      CREATE OR REPLACE FUNCTION "${triggerFn}"() RETURNS TRIGGER
      SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO "${changelog}" (operation, row_id, row_data)
          VALUES ('INSERT', NEW.id::text, to_jsonb(NEW));
          RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
          INSERT INTO "${changelog}" (operation, row_id, row_data)
          VALUES ('UPDATE', NEW.id::text, to_jsonb(NEW));
          RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO "${changelog}" (operation, row_id, row_data)
          VALUES ('DELETE', OLD.id::text, NULL);
          RETURN OLD;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER "${trigger}"
      AFTER INSERT OR UPDATE OR DELETE ON "${tableName}"
      FOR EACH ROW EXECUTE FUNCTION "${triggerFn}"();
    `,
      )
      .execute(db);

    return {
      originalTable: tableName,
      ghostTable: ghost,
      changelogTable: changelog,
      triggerName: trigger,
      foreignKeys: fks.rows.map(({ add, validate }) => ({ add, validate })),
      indexes: indexes.rows,
      columns,
    };
  }

  /**
   * STEP 2: Copy data from original → ghost in cursor-based batches.
   * Cursor-based (ORDER BY id with WHERE id > lastId) guarantees consistency
   * even if inserts happen on original in parallel.
   * Returns total number of rows copied.
   */
  static async batchCopy(
    db: Database,
    migration: GhostMigration,
    onProgress?: (copied: number, total: number) => void,
  ): Promise<number> {
    // Every read of the original goes through `inEveryTenant`; the ghost has no
    // RLS until the swap, so its side needs none.
    const countResult = await inEveryTenant(db, (trx) =>
      sql<{ cnt: string }>`SELECT count(*) AS cnt FROM ${sql.id(migration.originalTable)}`.execute(
        trx,
      ),
    );
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    if (total === 0) {
      onProgress?.(0, 0);
      return 0;
    }

    // Named on both sides — `SELECT *` matched by position, which a DROP COLUMN
    // shifts and a RENAME does not follow.
    const target = sql.join(migration.columns.map((c) => sql.id(c.ghost)));
    const source = sql.join(migration.columns.map((c) => sql.id(c.original)));

    let copied = 0;
    let lastId: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Count from RETURNING, never from `numAffectedRows`. The Bun SQL
      // dialect does not populate it for raw `sql` executes at all, so the
      // first branch fell back to `?? BATCH_SIZE` (kept looping) and the second
      // to `?? 0` (broke immediately). The backfill therefore copied exactly
      // TWO batches and reported success — on a table larger than 20,000 rows
      // the ghost table was swapped in incomplete, losing every row beyond
      // that. Data loss with a green log line.
      const after = lastId;
      const result = await inEveryTenant(db, (trx) =>
        sql<{ id: string }>`
          INSERT INTO ${sql.id(migration.ghostTable)} (${target})
          SELECT ${source} FROM ${sql.id(migration.originalTable)}
          ${after === null ? sql`` : sql`WHERE id > ${after}`}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `.execute(trx),
      );
      const batchRows = result.rows.length;

      copied += batchRows;

      // Get last copied id for next cursor
      const lastRow = await sql<{ id: string }>`
        SELECT id FROM ${sql.id(migration.ghostTable)} ORDER BY id DESC LIMIT 1
      `.execute(db);
      lastId = lastRow.rows[0]?.id ?? null;

      onProgress?.(Math.min(copied, total), total);

      // Done if batch is smaller than BATCH_SIZE
      if (batchRows < BATCH_SIZE) break;

      // Micro-pause to avoid overwhelming DB in production
      await new Promise((r) => setTimeout(r, 50));
    }

    return copied;
  }

  /**
   * STEP 3: Apply all changelog entries to ghost table.
   * These are the mutations that occurred on original during batch copy.
   * Returns number of entries applied.
   */
  static async applyChangelog(db: Database, migration: GhostMigration): Promise<number> {
    const changes = await sql<{
      id: string;
      operation: string;
      row_id: string;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      row_data: any;
    }>`
      SELECT id, operation, row_id, row_data
      FROM ${sql.id(migration.changelogTable)}
      ORDER BY id
    `.execute(db);

    let applied = 0;

    for (const change of changes.rows) {
      if (change.operation === 'DELETE') {
        // Delete from ghost if exists
        await sql`
          DELETE FROM ${sql.id(migration.ghostTable)}
          WHERE id = ${change.row_id}
        `.execute(db);
      } else {
        // INSERT or UPDATE — upsert in ghost
        // row_data is the complete row snapshot (to_jsonb(NEW))
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const data = change.row_data as Record<string, any>;
        if (!data) continue;

        // The snapshot is keyed by the ORIGINAL's column names; a dropped column
        // has no ghost column, a renamed one lands under its new name.
        const columns = migration.columns.filter((c) => Object.hasOwn(data, c.original));
        if (columns.length === 0) continue;

        const updateCols = columns.filter((c) => c.ghost !== 'id');
        const colsSql = sql.join(columns.map((c) => sql.id(c.ghost)));
        // Postgres turns the snapshot back into the original's row type, the
        // inverse of the trigger's to_jsonb. Binding the parsed JSON values from
        // here instead sent a jsonb array as a Postgres array, and the swapped-in
        // table held the string '{"1","2"}' where the row had held [1,2].
        const valsSql = sql.join(columns.map((c) => sql`r.${sql.id(c.original)}`));
        const updateSql =
          updateCols.length > 0
            ? sql.join(updateCols.map((c) => sql`${sql.id(c.ghost)} = EXCLUDED.${sql.id(c.ghost)}`))
            : sql`${sql.id('id')} = EXCLUDED.${sql.id('id')}`; // no-op update to avoid syntax errors

        await sql`
          INSERT INTO ${sql.id(migration.ghostTable)} (${colsSql})
          SELECT ${valsSql}
          FROM ${sql.id(migration.changelogTable)} c,
               jsonb_populate_record(NULL::${sql.id(migration.originalTable)}, c.row_data) r
          WHERE c.id = ${change.id}
          ON CONFLICT (id) DO UPDATE SET ${updateSql}
        `.execute(db);
      }
      applied++;
    }

    // Replayed entries leave the changelog, so the replay under the swap's lock
    // reads only what landed since, not every write made during the copy. The
    // ids read are exactly the ones committed and applied: an entry committed
    // later is kept even with a lower id, and two entries for one row were
    // serialized by its row lock, so their id order is their commit order.
    if (changes.rows.length > 0) {
      await sql`
        DELETE FROM ${sql.id(migration.changelogTable)}
        WHERE id = ANY(${changes.rows.map((c) => c.id)}::bigint[])
      `.execute(db);
    }

    return applied;
  }

  /**
   * STEP 4: THE SWAP — Atomic rename with minimal lock.
   *
   * Exact sequence (in transaction):
   *   LOCK TABLE original IN SHARE ROW EXCLUSIVE MODE  ← blocks writes (not reads!)
   *   ALTER TABLE original RENAME TO _zv_old_original  ← original disappears
   *   ALTER TABLE ghost    RENAME TO original           ← ghost becomes original
   *   DROP TRIGGER changelog_trigger ON _zv_old_original
   *   DROP FUNCTION changelog_trigger_fn()
   *
   * Lock lasts a few milliseconds (3 RENAME commands).
   * Reads continue uninterrupted during lock.
   * Cleanup (DROP TABLE old + changelog) is done async after 60s.
   */
  static async atomicSwap(db: Database, migration: GhostMigration): Promise<void> {
    const oldTable = `_zv_old_${migration.originalTable}`;
    const triggerFn = `${migration.triggerName}_fn`;

    // Apply last changelog entries before swap (between last batchCopy and LOCK)
    await GhostDDL.applyChangelog(db, migration);

    let carried: { step: number; ddl: string }[] = [];
    let owned: [string, string | null][] = [];

    // Transaction with LOCK + atomic RENAME
    await db.transaction().execute(async (trx) => {
      // SHARE ROW EXCLUSIVE: blocks INSERT/UPDATE/DELETE, allows SELECT
      await sql
        .raw(`LOCK TABLE "${migration.originalTable}" IN SHARE ROW EXCLUSIVE MODE`)
        .execute(trx);

      // Apply any writes that arrived in changelog in the window between
      // the last applyChangelog above and the LOCK moment
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      await GhostDDL.applyChangelog(trx as any, migration);

      // Nothing writes the original now, so the ghost must hold exactly its
      // rows. A copy that lost some — for any reason, the tenant blindness this
      // once had included — stops here, before the rename makes it permanent.
      // ponytail: a count, not a per-row diff; enough to catch a lossy copy.
      //
      // The count has to see every row the old copy's DROP will destroy, not the
      // rows RLS lets the owner read. Under FORCE even `publishEveryTenant` hides
      // a row whose tenant_id names no `zv_tenants` row (its firm deleted, data
      // restored as a superuser): the copy skipped it, a count under the same
      // reach agreed, and the swap dropped it. Lifting FORCE exempts the owner,
      // as Postgres does for any owner of an unforced table. It is restored
      // before anything else runs, and ALTER holds ACCESS EXCLUSIVE — which the
      // rename below takes anyway, only now from the count on — so no other
      // session ever reads the table unforced.
      const force = await sql<{ forced: boolean }>`
        SELECT relforcerowsecurity AS forced FROM pg_class
        WHERE oid = to_regclass(quote_ident(${migration.originalTable}))
      `.execute(trx);
      const forced = force.rows[0]?.forced === true;
      const original = sql.id(migration.originalTable);
      if (forced) await sql`ALTER TABLE ${original} NO FORCE ROW LEVEL SECURITY`.execute(trx);
      const counted = await sql<{ original_rows: string; ghost_rows: string }>`
        SELECT (SELECT count(*) FROM ${original}) AS original_rows,
               (SELECT count(*) FROM ${sql.id(migration.ghostTable)}) AS ghost_rows
      `.execute(trx);
      if (forced) await sql`ALTER TABLE ${original} FORCE ROW LEVEL SECURITY`.execute(trx);
      const { original_rows, ghost_rows } = counted.rows[0] ?? {};
      if (original_rows === undefined || Number(original_rows) !== Number(ghost_rows)) {
        throw new Error(
          `[ghost-ddl] refusing to swap ${migration.originalTable}: row count ` +
            `${original_rows} in the original, ${ghost_rows} in the ghost. Rows whose ` +
            `tenant_id names no zv_tenants row are not copied; reassign or delete them first`,
        );
      }

      // Read before the rename, run after it — see carriedOverDdl.
      carried = await carriedOverDdl(
        trx,
        migration.originalTable,
        migration.ghostTable,
        migration.triggerName,
      );

      // A previous swap's old copy, if its cleanup has not run yet: dead since
      // that swap committed (see sweepGhostOrphans).
      await sql`DROP TABLE IF EXISTS ${sql.id(oldTable)}`.execute(trx);

      // Swap atomic: original → old, ghost → original
      await sql
        .raw(`ALTER TABLE "${migration.originalTable}" RENAME TO "${oldTable}"`)
        .execute(trx);
      await sql
        .raw(`ALTER TABLE "${migration.ghostTable}" RENAME TO "${migration.originalTable}"`)
        .execute(trx);

      // Cleanup trigger (was on original, now renamed to old)
      await sql
        .raw(`DROP TRIGGER IF EXISTS "${migration.triggerName}" ON "${oldTable}"`)
        .execute(trx);
      await sql.raw(`DROP FUNCTION IF EXISTS "${triggerFn}"()`).execute(trx);

      // The old copy's index moves aside first, freeing its name — also when
      // the DDL dropped the column its copy was on. Renaming an index renames
      // the constraint it backs (primary key, unique) with it.
      for (const ix of migration.indexes ?? []) {
        const found = await sql<{ old: string | null; live: string | null }>`
          SELECT to_regclass(quote_ident(${ix.original}))::oid::text AS old,
                 to_regclass(quote_ident(${ix.ghost}))::text AS live
        `.execute(trx);
        const { old, live } = found.rows[0] ?? {};
        if (old) {
          await sql`ALTER INDEX ${sql.id(ix.original)} RENAME TO ${sql.id(`_zv_old_idx_${old}`)}`.execute(
            trx,
          );
        }
        if (live)
          await sql`ALTER INDEX ${sql.id(ix.ghost)} RENAME TO ${sql.id(ix.original)}`.execute(trx);
      }

      // Inside the transaction: a statement that no longer fits the new columns
      // (a policy naming a dropped or renamed column) rolls the swap back rather
      // than committing a table without its triggers, RLS, policies or grants.
      for (const { step, ddl } of carried) if (step < 100) await sql.raw(ddl).execute(trx);
      for (const fk of migration.foreignKeys ?? []) await sql.raw(fk.add).execute(trx);

      // What the cleanup may drop, by oid: a later run on this table reuses both
      // names, and a drop by name would take that run's changelog mid-copy.
      const ids = await sql<{ old: string | null; log: string | null }>`
        SELECT to_regclass(quote_ident(${oldTable}))::oid::text AS old,
               to_regclass(quote_ident(${migration.changelogTable}))::oid::text AS log
      `.execute(trx);
      owned = [
        [oldTable, ids.rows[0]?.old ?? null],
        [migration.changelogTable, ids.rows[0]?.log ?? null],
      ];
    });

    // After commit, off the lock: a foreign key re-added NOT VALID is enforced
    // for every new write already; validating only re-checks the copied rows.
    const validations = [
      ...carried.filter((c) => c.step >= 100).map((c) => c.ddl),
      ...(migration.foreignKeys ?? []).map((fk) => fk.validate),
    ];
    for (const ddl of validations) {
      try {
        await sql.raw(ddl).execute(db);
      } catch (err) {
        console.warn(
          `[ghost-ddl] ${ddl} failed after the swap; the constraint is in place and enforced ` +
            `for new writes but stays NOT VALID:`,
          (err as Error).message,
        );
      }
    }

    // Cleanup async after 60s (safety net — doesn't block response)
    const cleanup = async () => {
      try {
        await db.transaction().execute(async (trx) => {
          for (const [name, oid] of owned) {
            const at = sql<{ oid: string | null }>`
              SELECT to_regclass(quote_ident(${name}))::oid::text AS oid`;
            if (!oid || (await at.execute(trx)).rows[0]?.oid !== oid) continue;
            // Locked, then checked again: the name can only move before the lock.
            await sql`LOCK TABLE ${sql.id(name)} IN ACCESS EXCLUSIVE MODE`.execute(trx);
            if ((await at.execute(trx)).rows[0]?.oid !== oid) continue;
            await sql`DROP TABLE ${sql.id(name)}`.execute(trx);
          }
        });
      } catch (err) {
        // Not fatal — a background timer has nobody to throw to — but silence
        // is what let these accumulate unnoticed. `sweepGhostOrphans` reclaims
        // them on the next boot; saying so here is what makes that traceable.
        console.warn(
          `[ghost-ddl] post-swap cleanup failed for ${oldTable}; it will be reclaimed at next boot:`,
          (err as Error).message,
        );
      }
    };
    const timer = setTimeout(() => {
      _pendingCleanups.delete(timer);
      return cleanup();
    }, 60_000);
    _pendingCleanups.set(timer, cleanup);
  }

  /**
   * Orchestrates the entire Ghost DDL process:
   *   createGhost → batchCopy → applyChangelog → atomicSwap
   *
   * onProgress receives (phase, detail) for logging/UI.
   */
  static async execute(
    db: Database,
    tableName: string,
    operations: GhostOperation[],
    onProgress?: (phase: string, detail: string) => void,
  ): Promise<void> {
    // BYOD Guard: don't run Ghost DDL on unmanaged tables.
    //
    // The same guard as `skipForByod` in `ddl-queue.ts`, and it had the same hole.
    // `.catch(() => null)` made `meta` null, the `is_managed === false` test below
    // never fired, and Ghost DDL proceeded — on a table whose ownership could not be
    // established. Ghost DDL is not a small operation to get wrong: it copies the
    // table, applies the DDL to the copy, backfills, and swaps. Running that over a
    // BYOD table holding a customer's own data is the outcome this guard exists to
    // prevent, and a transient read error was enough to disable it.
    const collectionName = tableName.replace(/^zvd_/, '');
    let meta: { is_managed: boolean | null } | undefined;
    try {
      meta = await db
        .selectFrom('zvd_collections')
        .select('is_managed')
        .where('name', '=', collectionName)
        .executeTakeFirst();
    } catch (err) {
      onProgress?.(
        'skipped',
        `Table "${tableName}": could not read is_managed, so ownership is unknown. ` +
          `Refusing to run Ghost DDL. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (meta && meta.is_managed === false) {
      onProgress?.('skipped', `Table "${tableName}" is unmanaged (BYOD). No DDL allowed.`);
      return;
    }

    // `createGhost` used to run before this try block, so a failure inside it
    // (changelog table or trigger creation failing after the ghost table was
    // already created, or a leftover `_zv_ghost_<table>` from a prior crashed
    // run making the CREATE TABLE itself fail) reached the caller with no
    // cleanup at all — not even the cleanup below, which only ever ran for
    // failures in the steps AFTER createGhost. `migration` is therefore only
    // assigned on success; the catch rebuilds the same names createGhost
    // derives internally so cleanup still has something to act on.
    let migration: GhostMigration | undefined;
    try {
      onProgress?.('creating', `Creating ghost table and changelog trigger for "${tableName}"`);
      migration = await GhostDDL.createGhost(db, tableName, operations);

      onProgress?.('copying', 'Batch copying data from original to ghost table');
      const copied = await GhostDDL.batchCopy(db, migration, (done, total) => {
        onProgress?.('copying', `Copied ${done}/${total} rows`);
      });

      onProgress?.('changelog', 'Applying changelog mutations accumulated during copy');
      const changelogApplied = await GhostDDL.applyChangelog(db, migration);

      onProgress?.('swapping', 'Performing atomic table swap (lock ~ms)');
      await GhostDDL.atomicSwap(db, migration);

      onProgress?.(
        'done',
        `Migration complete: ${copied} rows copied, ${changelogApplied} changelog entries applied`,
      );
    } catch (err) {
      // Cleanup ghost tables on failure to prevent accumulation
      const ghostTable = migration?.ghostTable ?? `_zv_ghost_${tableName}`;
      const changelogTable = migration?.changelogTable ?? `_zv_changelog_${tableName}`;
      const triggerName = migration?.triggerName ?? `_zv_trg_ghost_${tableName}`;
      const originalTable = migration?.originalTable ?? tableName;
      try {
        await sql`DROP TABLE IF EXISTS ${sql.id(ghostTable)} CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS ${sql.id(changelogTable)} CASCADE`.execute(db);
        const triggerFn = `${triggerName}_fn`;
        // sql.id(), not raw string interpolation: when createGhost threw before
        // returning (e.g. its own name-validation check), `originalTable` falls
        // back to the caller-supplied `tableName`, which has not been validated
        // at this point.
        await sql`DROP TRIGGER IF EXISTS ${sql.id(triggerName)} ON ${sql.id(originalTable)}`
          .execute(db)
          .catch((cleanupErr: Error) => {
            console.warn(
              `[ghost-ddl] DROP TRIGGER cleanup failed for ${triggerName}:`,
              cleanupErr.message,
            );
          });
        await sql`DROP FUNCTION IF EXISTS ${sql.id(triggerFn)}()`
          .execute(db)
          .catch((cleanupErr: Error) => {
            console.warn(
              `[ghost-ddl] DROP FUNCTION cleanup failed for ${triggerFn}:`,
              cleanupErr.message,
            );
          });
      } catch (cleanupErr) {
        console.warn('[GhostDDL] Cleanup after failure also failed:', cleanupErr);
      }
      throw err;
    }
  }
}

/** What one sweep reclaimed, so the caller can report it. */
export interface GhostSweepResult {
  /** `_zv_old_` tables dropped, with their changelogs. */
  dropped: string[];
  /** `_zv_ghost_` tables seen but deliberately left alone. */
  abandonedGhosts: string[];
  /** Tables a DROP refused to give up, with the reason. */
  failed: { table: string; reason: string }[];
}

const OLD_PREFIX = '_zv_old_';
const GHOST_PREFIX = '_zv_ghost_';
const CHANGELOG_PREFIX = '_zv_changelog_';

/**
 * Reclaim the tables a Ghost DDL run left behind.
 *
 * The post-swap DROP is an in-process `setTimeout` sixty seconds out. A process
 * that exits first leaves `_zv_old_<table>` and its changelog on disk for good —
 * and that is not the rare case: `cancelPendingCleanups()` runs on graceful
 * shutdown, so an ordinary deploy inside the window cancels the DROP outright.
 * What stays behind is the pre-migration table itself — every row, still under
 * its own policies, but read by nothing and stale from the swap on — and
 * nothing ever came back for it.
 *
 * `_zv_old_` is created only inside the swap transaction, after the ghost has
 * already taken the original's name. A table with that prefix is therefore dead
 * by construction — the swap it belonged to has committed — so dropping it at
 * boot is safe even while another instance is running.
 *
 * `_zv_ghost_` is a different animal: a run on another instance may be copying
 * into it at this very moment, and no lock exists to tell us apart from it. Those
 * are reported and left alone.
 */
export async function sweepGhostOrphans(db: Database): Promise<GhostSweepResult> {
  const result: GhostSweepResult = { dropped: [], abandonedGhosts: [], failed: [] };

  // `LIKE` needs the underscores escaped or `_` matches any single character,
  // which would pull in unrelated tables that merely resemble the prefix.
  // `_` is a single-character wildcard in LIKE, so the prefixes have to be
  // escaped or `_zv_old_%` also matches any table shaped <any>zv<any>old<any>.
  // The escape character is `!` rather than the conventional backslash because
  // a backslash in a template literal is an escape sequence of its own and the
  // pattern would reach PostgreSQL with the escaping already stripped out.
  const rows = await sql<{ tablename: string }>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = current_schema()
      AND (tablename LIKE '!_zv!_old!_%' ESCAPE '!'
        OR tablename LIKE '!_zv!_ghost!_%' ESCAPE '!')
    ORDER BY tablename
  `.execute(db);

  for (const { tablename } of rows.rows) {
    if (tablename.startsWith(GHOST_PREFIX)) {
      result.abandonedGhosts.push(tablename);
      continue;
    }

    const original = tablename.slice(OLD_PREFIX.length);
    const changelog = `${CHANGELOG_PREFIX}${original}`;
    try {
      // The changelog goes first: it is the one the swap's trigger wrote into,
      // and dropping the copy while its changelog survives is the half-cleanup
      // that made this hard to spot in the first place.
      await sql`DROP TABLE IF EXISTS ${sql.id(changelog)}`.execute(db);
      await sql`DROP TABLE IF EXISTS ${sql.id(tablename)}`.execute(db);
      result.dropped.push(tablename);
    } catch (err) {
      result.failed.push({ table: tablename, reason: (err as Error).message });
    }
  }

  return result;
}
