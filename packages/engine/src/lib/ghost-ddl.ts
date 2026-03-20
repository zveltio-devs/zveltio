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

import type { Database } from '../db/index.js';
import { sql } from 'kysely';

const BATCH_SIZE = 10_000;

export interface GhostMigration {
  originalTable: string;
  ghostTable: string;
  changelogTable: string;
  triggerName: string;
}

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
    const ghost = `_zv_ghost_${tableName}`;
    const changelog = `_zv_changelog_${tableName}`;
    const triggerFn = `_zv_trg_ghost_${tableName}_fn`;
    const trigger = `_zv_trg_ghost_${tableName}`;

    // 1. Create ghost table with same structure (including indexes, constraints)
    await sql`CREATE TABLE ${sql.id(ghost)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(
      db,
    );

    // 2. Apply DDL changes on ghost — strict validation to prevent SQL injection
    const ALLOWED_DDL_RE =
      /^(ADD\s+COLUMN|DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?|ALTER\s+COLUMN|RENAME\s+COLUMN)\s+/i;
    for (const ddl of ddlStatements) {
      if (!ALLOWED_DDL_RE.test(ddl.trim())) {
        throw new Error(
          `Unsafe DDL statement rejected: "${ddl}". ` +
            `Only ADD COLUMN, DROP COLUMN, ALTER COLUMN, RENAME COLUMN are allowed.`,
        );
      }
      await sql.raw(`ALTER TABLE "${ghost}" ${ddl}`).execute(db);
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

      if (lastId === null) {
        // First iteration — without cursor
        const result = await sql`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
        `.execute(db);
        batchRows = Number((result as any).numAffectedRows ?? BATCH_SIZE);
      } else {
        // Subsequent iterations — cursor-based
        const result = await sql`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          WHERE id > ${lastId}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
        `.execute(db);
        batchRows = Number((result as any).numAffectedRows ?? 0);
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
  static async applyChangelog(
    db: Database,
    migration: GhostMigration,
  ): Promise<number> {
    const changes = await sql<{
      id: string;
      operation: string;
      row_id: string;
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
        const data = change.row_data as Record<string, any>;
        if (!data) continue;

        const columns = Object.keys(data);
        if (columns.length === 0) continue;

        // Build parameterized upsert with sql template (no string concatenation)
        const updateCols = columns.filter((c) => c !== 'id');

        // Use INSERT ... ON CONFLICT DO UPDATE with individual values
        // to avoid SQL concatenation (security + correctness)
        const colsSql = sql.raw(columns.map((c) => `"${c}"`).join(', '));
        const valsSql = sql.join(columns.map((c) => sql`${data[c]}`));
        const updateSql =
          updateCols.length > 0
            ? sql.raw(
                updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', '),
              )
            : sql.raw('"id" = EXCLUDED."id"'); // no-op update to avoid syntax errors

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
  static async atomicSwap(
    db: Database,
    migration: GhostMigration,
  ): Promise<void> {
    const oldTable = `_zv_old_${migration.originalTable}`;
    const triggerFn = `${migration.triggerName}_fn`;

    // Apply last changelog entries before swap (between last batchCopy and LOCK)
    await GhostDDL.applyChangelog(db, migration);

    // Transaction with LOCK + atomic RENAME
    await db.transaction().execute(async (trx) => {
      // SHARE ROW EXCLUSIVE: blocks INSERT/UPDATE/DELETE, allows SELECT
      await sql
        .raw(
          `LOCK TABLE "${migration.originalTable}" IN SHARE ROW EXCLUSIVE MODE`,
        )
        .execute(trx);

      // Apply any writes that arrived in changelog in the window between
      // the last applyChangelog above and the LOCK moment
      await GhostDDL.applyChangelog(trx as any, migration);

      // Swap atomic: original → old, ghost → original
      await sql
        .raw(`ALTER TABLE "${migration.originalTable}" RENAME TO "${oldTable}"`)
        .execute(trx);
      await sql
        .raw(
          `ALTER TABLE "${migration.ghostTable}" RENAME TO "${migration.originalTable}"`,
        )
        .execute(trx);

      // Cleanup trigger (was on original, now renamed to old)
      await sql
        .raw(
          `DROP TRIGGER IF EXISTS "${migration.triggerName}" ON "${oldTable}"`,
        )
        .execute(trx);
      await sql.raw(`DROP FUNCTION IF EXISTS "${triggerFn}"()`).execute(trx);
    });

    // Cleanup async after 60s (safety net — doesn't block response)
    setTimeout(async () => {
      try {
        await sql`DROP TABLE IF EXISTS ${sql.id(oldTable)}`.execute(db);
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.changelogTable)}`.execute(
          db,
        );
      } catch {
        /* best-effort cleanup — don't throw errors in background */
      }
    }, 60_000);
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
    // BYOD Guard: don't run Ghost DDL on unmanaged tables
    const collectionName = tableName.replace(/^zvd_/, '');
    const meta = await (db as any)
      .selectFrom('zvd_collections')
      .select('is_managed')
      .where('name', '=', collectionName)
      .executeTakeFirst()
      .catch(() => null);

    if (meta && meta.is_managed === false) {
      onProgress?.(
        'skipped',
        `Table "${tableName}" is unmanaged (BYOD). No DDL allowed.`,
      );
      return;
    }

    onProgress?.(
      'creating',
      `Creating ghost table and changelog trigger for "${tableName}"`,
    );
    const migration = await GhostDDL.createGhost(db, tableName, ddlStatements);

    try {
      onProgress?.(
        'copying',
        'Batch copying data from original to ghost table',
      );
      const copied = await GhostDDL.batchCopy(db, migration, (done, total) => {
        onProgress?.('copying', `Copied ${done}/${total} rows`);
      });

      onProgress?.(
        'changelog',
        'Applying changelog mutations accumulated during copy',
      );
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
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.ghostTable)} CASCADE`.execute(
          db,
        );
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.changelogTable)} CASCADE`.execute(
          db,
        );
        const triggerFn = `${migration.triggerName}_fn`;
        await sql
          .raw(
            `DROP TRIGGER IF EXISTS "${migration.triggerName}" ON "${migration.originalTable}"`,
          )
          .execute(db)
          .catch(() => {});
        await sql
          .raw(`DROP FUNCTION IF EXISTS "${triggerFn}"()`)
          .execute(db)
          .catch(() => {});
      } catch (cleanupErr) {
        console.warn(
          '[GhostDDL] Cleanup after failure also failed:',
          cleanupErr,
        );
      }
      throw err;
    }
  }
}
