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

const BATCH_SIZE = 10_000;

// Track pending cleanup timers so they can be cancelled at shutdown
const _pendingCleanups = new Set<ReturnType<typeof setTimeout>>();

/** Cancel all pending Ghost DDL cleanup timers (call on graceful shutdown). */
export function cancelPendingCleanups(): void {
  for (const timer of _pendingCleanups) clearTimeout(timer);
  _pendingCleanups.clear();
}

export interface GhostMigration {
  originalTable: string;
  ghostTable: string;
  changelogTable: string;
  triggerName: string;
}

/**
 * Whether a single ALTER TABLE fragment is safe to interpolate.
 *
 * Anchored at BOTH ends. Matching only the prefix validated the verb and then
 * passed whatever followed into sql.raw — and the pool speaks Postgres'
 * simple-query protocol, which accepts several commands at once, so
 * `ADD COLUMN x int; DROP TABLE "user"; --` was accepted and executed in full.
 *
 * The tail has to allow string literals, because real migrations carry them
 * (`TEXT NOT NULL DEFAULT ''`, `SET DEFAULT 'migrated'`). A literal is matched
 * as one atom with `''` as the escape, so a quote is never left dangling to open
 * injected code, `;` stays outside the unquoted character class, and `-` is
 * excluded from it so `--` cannot start a comment.
 *
 * Exported so the tests exercise this exact matcher: the first version of this
 * guard was too strict and rejected legitimate migrations, and a test carrying
 * its own copy of the regex would have agreed with it.
 */
export function isAllowedGhostDdl(statement: string): boolean {
  // Plain strings where there is no backslash, `String.raw` where there is.
  //
  // Not cosmetic, and worth the care: this regex is what decides which DDL an
  // extension may run, so a fragment that silently loses a `\` is a hole. The
  // two spellings are mixed ON PURPOSE — biome's `noUselessStringRaw` flags a
  // raw literal with nothing to escape — so anyone ADDING a backslash to one of
  // the plain ones below must switch it to `String.raw` in the same edit.
  const IDENT = '(?:"[a-zA-Z_][a-zA-Z0-9_]*"|[a-zA-Z_][a-zA-Z0-9_]*)';
  const STRING_LIT = "'(?:[^']|'')*'";
  const TYPE_TAIL = String.raw`(?:[a-zA-Z0-9_ ,()\[\].:]|${STRING_LIT})*`;
  const ALLOWED_DDL_RE = new RegExp(
    '^(?:' +
      String.raw`ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+${TYPE_TAIL}` +
      String.raw`|DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?${IDENT}` +
      String.raw`|ALTER\s+COLUMN\s+${IDENT}\s+${TYPE_TAIL}` +
      String.raw`|RENAME\s+COLUMN\s+${IDENT}\s+TO\s+${IDENT}` +
      ')$',
    'i',
  );
  return ALLOWED_DDL_RE.test(statement.trim());
}

// raw-ident-ok-file: every identifier this module interpolates is derived from
// the `tableName` that `createGhost` validates against /^[a-zA-Z_][a-zA-Z0-9_]*$/
// before building anything from it — the ghost table, the changelog table, the
// trigger and its function are all that name plus a literal prefix, and the
// `migration` record carried between steps holds those same four strings.
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
    ddlStatements: string[], // ex: ['ADD COLUMN phone TEXT', 'DROP COLUMN fax']
  ): Promise<GhostMigration> {
    // Validated here rather than trusted from the caller. Four identifiers are
    // derived from this one string and every one is interpolated into a
    // `sql.raw` template below, so a name carrying a double quote would escape
    // the identifier and land arbitrary SQL inside a DDL statement.
    //
    // Nothing in the product calls this yet — only tests do — which is exactly
    // when an entry point is cheapest to close.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`Unsafe table name for ghost migration: "${tableName}"`);
    }

    const ghost = `_zv_ghost_${tableName}`;
    const changelog = `_zv_changelog_${tableName}`;
    const triggerFn = `_zv_trg_ghost_${tableName}_fn`;
    const trigger = `_zv_trg_ghost_${tableName}`;

    // 1. Create ghost table with same structure (including indexes, constraints)
    await sql`CREATE TABLE ${sql.id(ghost)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(db);

    // 2. Apply DDL changes on ghost — see isAllowedGhostDdl.
    for (const ddl of ddlStatements) {
      const trimmed = ddl.trim();
      if (!isAllowedGhostDdl(trimmed)) {
        throw new Error(
          `Unsafe DDL statement rejected: "${ddl}". ` +
            `Only ADD COLUMN, DROP COLUMN, ALTER COLUMN, RENAME COLUMN are allowed.`,
        );
      }
      await sql.raw(`ALTER TABLE "${ghost}" ${trimmed}`).execute(db);
    }

    // 3. Changelog table — captures all mutations during batch copy
    await sql`
      CREATE TABLE ${sql.id(changelog)} (
        id        BIGSERIAL PRIMARY KEY,
        operation TEXT      NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
        row_id    TEXT      NOT NULL,
        row_data  JSONB,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);

    // 4. Trigger function + trigger on original table
    //    Any write to original while we copy is saved to changelog.
    await sql
      .raw(
        `
      CREATE OR REPLACE FUNCTION "${triggerFn}"() RETURNS TRIGGER AS $$
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
    // Count total rows to copy
    const countResult = await sql<{ cnt: string }>`
      SELECT count(*) AS cnt FROM ${sql.id(migration.originalTable)}
    `.execute(db);
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    if (total === 0) {
      onProgress?.(0, 0);
      return 0;
    }

    let copied = 0;
    let lastId: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let batchRows: number;

      // Count from RETURNING, never from `numAffectedRows`. The Bun SQL
      // dialect does not populate it for raw `sql` executes at all, so the
      // first branch fell back to `?? BATCH_SIZE` (kept looping) and the second
      // to `?? 0` (broke immediately). The backfill therefore copied exactly
      // TWO batches and reported success — on a table larger than 20,000 rows
      // the ghost table was swapped in incomplete, losing every row beyond
      // that. Data loss with a green log line.
      if (lastId === null) {
        // First iteration — without cursor
        const result = await sql<{ id: string }>`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `.execute(db);
        batchRows = result.rows.length;
      } else {
        // Subsequent iterations — cursor-based
        const result = await sql<{ id: string }>`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          WHERE id > ${lastId}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `.execute(db);
        batchRows = result.rows.length;
      }

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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
        const data = change.row_data as Record<string, any>;
        if (!data) continue;

        const columns = Object.keys(data);
        if (columns.length === 0) continue;

        // Build parameterized upsert with sql template (no string concatenation)
        const updateCols = columns.filter((c) => c !== 'id');

        // Use INSERT ... ON CONFLICT DO UPDATE with individual values
        // to avoid SQL concatenation (security + correctness)
        const colsSql = sql.join(columns.map((c) => sql.id(c)));
        const valsSql = sql.join(columns.map((c) => sql`${data[c]}`));
        const updateSql =
          updateCols.length > 0
            ? sql.join(updateCols.map((c) => sql`${sql.id(c)} = EXCLUDED.${sql.id(c)}`))
            : sql`${sql.id('id')} = EXCLUDED.${sql.id('id')}`; // no-op update to avoid syntax errors

        await sql`
          INSERT INTO ${sql.id(migration.ghostTable)} (${colsSql})
          VALUES (${valsSql})
          ON CONFLICT (id) DO UPDATE SET ${updateSql}
        `.execute(db);
      }
      applied++;
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

    // Transaction with LOCK + atomic RENAME
    await db.transaction().execute(async (trx) => {
      // SHARE ROW EXCLUSIVE: blocks INSERT/UPDATE/DELETE, allows SELECT
      await sql
        .raw(`LOCK TABLE "${migration.originalTable}" IN SHARE ROW EXCLUSIVE MODE`)
        .execute(trx);

      // Apply any writes that arrived in changelog in the window between
      // the last applyChangelog above and the LOCK moment
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      await GhostDDL.applyChangelog(trx as any, migration);

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
    });

    // Cleanup async after 60s (safety net — doesn't block response)
    const timer = setTimeout(async () => {
      _pendingCleanups.delete(timer);
      try {
        await sql`DROP TABLE IF EXISTS ${sql.id(oldTable)}`.execute(db);
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.changelogTable)}`.execute(db);
      } catch (err) {
        // Not fatal — a background timer has nobody to throw to — but silence
        // is what let these accumulate unnoticed. `sweepGhostOrphans` reclaims
        // them on the next boot; saying so here is what makes that traceable.
        console.warn(
          `[ghost-ddl] post-swap cleanup failed for ${oldTable}; it will be reclaimed at next boot:`,
          (err as Error).message,
        );
      }
    }, 60_000);
    _pendingCleanups.add(timer);
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
    ddlStatements: string[],
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

    onProgress?.('creating', `Creating ghost table and changelog trigger for "${tableName}"`);
    const migration = await GhostDDL.createGhost(db, tableName, ddlStatements);

    try {
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
      try {
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.ghostTable)} CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.changelogTable)} CASCADE`.execute(db);
        const triggerFn = `${migration.triggerName}_fn`;
        await sql
          .raw(`DROP TRIGGER IF EXISTS "${migration.triggerName}" ON "${migration.originalTable}"`)
          .execute(db)
          .catch((cleanupErr: Error) => {
            console.warn(
              `[ghost-ddl] DROP TRIGGER cleanup failed for ${migration.triggerName}:`,
              cleanupErr.message,
            );
          });
        await sql
          .raw(`DROP FUNCTION IF EXISTS "${triggerFn}"()`)
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
 * What stays behind is a full copy of the original rows which, unlike the live
 * table, carries no tenant policies, and nothing ever came back for it.
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
