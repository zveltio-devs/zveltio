/**
 * Ghost DDL — Zero-Downtime Schema Migrations
 *
 * Algoritmul GitHub/PlanetScale: Ghost Table + Trigger Changelog + Batch Copy + Atomic Swap
 *
 * Pași:
 *   1. createGhost  — Creează ghost table (structura identică + modificările DDL aplicate pe ea)
 *                     + changelog table + trigger care capturează mutațiile live
 *   2. batchCopy    — Copiază datele existente în batch-uri (cursor-based, 10k/batch)
 *   3. applyChangelog — Aplică mutațiile acumulate în changelog pe ghost table
 *   4. atomicSwap   — LOCK scurt + RENAME atomic: original → old, ghost → original
 *                     Citirile continuă pe durata LOCK-ului, blocăm doar scrierile câteva ms.
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
   * PASUL 1: Creează ghost table identică cu originala + aplică modificările DDL pe ea.
   * Creează și changelog table + trigger care capturează INSERT/UPDATE/DELETE live.
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

    // 1. Creează ghost table cu aceeași structură (inclusiv indecși, constraints)
    await sql`CREATE TABLE ${sql.id(ghost)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(db);

    // 2. Aplică modificările DDL pe ghost (NU pe originală — asta e ideea)
    for (const ddl of ddlStatements) {
      await sql.raw(`ALTER TABLE "${ghost}" ${ddl}`).execute(db);
    }

    // 3. Changelog table — capturează toate mutațiile din timpul copierii batch
    await sql`
      CREATE TABLE ${sql.id(changelog)} (
        id        BIGSERIAL PRIMARY KEY,
        operation TEXT      NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
        row_id    TEXT      NOT NULL,
        row_data  JSONB,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);

    // 4. Trigger function + trigger pe tabela originală
    //    Orice scriere pe original în timp ce noi copiem se salvează în changelog.
    await sql.raw(`
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
    `).execute(db);

    return {
      originalTable: tableName,
      ghostTable: ghost,
      changelogTable: changelog,
      triggerName: trigger,
    };
  }

  /**
   * PASUL 2: Copiază datele din original → ghost în batch-uri cursor-based.
   * Cursor-based (ORDER BY id cu WHERE id > lastId) garantează consistența
   * chiar dacă se fac inserturi pe original în paralel.
   * Returnează numărul total de rânduri copiate.
   */
  static async batchCopy(
    db: Database,
    migration: GhostMigration,
    onProgress?: (copied: number, total: number) => void,
  ): Promise<number> {
    // Numără totalul de rânduri de copiat
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

    while (true) {
      let batchRows: number;

      if (lastId === null) {
        // Prima iterație — fără cursor
        const result = await sql`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
        `.execute(db);
        batchRows = Number((result as any).numAffectedRows ?? BATCH_SIZE);
      } else {
        // Iterații ulterioare — cursor-based
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

      // Obține ultimul id copiat pentru cursorul următor
      const lastRow = await sql<{ id: string }>`
        SELECT id FROM ${sql.id(migration.ghostTable)} ORDER BY id DESC LIMIT 1
      `.execute(db);
      lastId = lastRow.rows[0]?.id ?? null;

      onProgress?.(Math.min(copied, total), total);

      // Am terminat dacă batch-ul e mai mic decât BATCH_SIZE
      if (batchRows < BATCH_SIZE) break;

      // Micro-pauză pentru a nu sufoca DB-ul în producție
      await new Promise((r) => setTimeout(r, 50));
    }

    return copied;
  }

  /**
   * PASUL 3: Aplică toate intrările din changelog pe ghost table.
   * Acestea sunt mutațiile care au avut loc pe original în timpul copierii batch.
   * Returnează numărul de intrări aplicate.
   */
  static async applyChangelog(db: Database, migration: GhostMigration): Promise<number> {
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
        // Șterge din ghost dacă există
        await sql`
          DELETE FROM ${sql.id(migration.ghostTable)}
          WHERE id = ${change.row_id}
        `.execute(db);
      } else {
        // INSERT sau UPDATE — upsert în ghost
        // row_data este snapshot-ul complet al rândului (to_jsonb(NEW))
        const data = change.row_data as Record<string, any>;
        if (!data) continue;

        const columns = Object.keys(data);
        if (columns.length === 0) continue;

        // Construim upsert parametrizat cu sql template (fără concatenare string)
        const updateCols = columns.filter((c) => c !== 'id');

        // Folosim INSERT ... ON CONFLICT DO UPDATE cu valori individuale
        // pentru a evita concatenarea de SQL (securitate + corectitudine)
        const colsSql = sql.raw(columns.map((c) => `"${c}"`).join(', '));
        const valsSql = sql.join(columns.map((c) => sql`${data[c]}`));
        const updateSql = updateCols.length > 0
          ? sql.raw(updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', '))
          : sql.raw('"id" = EXCLUDED."id"'); // no-op update pentru evitarea erorilor de sintaxă

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
   * PASUL 4: THE SWAP — Rename atomic cu lock minim.
   *
   * Secvența exactă (în tranzacție):
   *   LOCK TABLE original IN SHARE ROW EXCLUSIVE MODE  ← blochează scrierile (nu citirile!)
   *   ALTER TABLE original RENAME TO _zv_old_original  ← original dispare
   *   ALTER TABLE ghost    RENAME TO original           ← ghost devine original
   *   DROP TRIGGER changelog_trigger ON _zv_old_original
   *   DROP FUNCTION changelog_trigger_fn()
   *
   * Lock durează câteva milisecunde (cât durează 3 RENAME-uri).
   * Citirile continuă neîntrerupte pe durata lock-ului.
   * Cleanup-ul (DROP TABLE old + changelog) se face async după 60s.
   */
  static async atomicSwap(db: Database, migration: GhostMigration): Promise<void> {
    const oldTable = `_zv_old_${migration.originalTable}`;
    const triggerFn = `${migration.triggerName}_fn`;

    // Aplică ultimele changelog entries înainte de swap (între ultimul batchCopy și LOCK)
    await GhostDDL.applyChangelog(db, migration);

    // Tranzacție cu LOCK + RENAME atomic
    await db.transaction().execute(async (trx) => {
      // SHARE ROW EXCLUSIVE: blochează INSERT/UPDATE/DELETE, permite SELECT
      await sql.raw(`LOCK TABLE "${migration.originalTable}" IN SHARE ROW EXCLUSIVE MODE`).execute(trx);

      // Aplică orice scrieri care au ajuns în changelog în fereastra dintre
      // ultimul applyChangelog de mai sus și momentul LOCK-ului
      await GhostDDL.applyChangelog(trx as any, migration);

      // Swap atomic: original → old, ghost → original
      await sql.raw(`ALTER TABLE "${migration.originalTable}" RENAME TO "${oldTable}"`).execute(trx);
      await sql.raw(`ALTER TABLE "${migration.ghostTable}" RENAME TO "${migration.originalTable}"`).execute(trx);

      // Cleanup trigger (era pe original, acum redenumit ca old)
      await sql.raw(`DROP TRIGGER IF EXISTS "${migration.triggerName}" ON "${oldTable}"`).execute(trx);
      await sql.raw(`DROP FUNCTION IF EXISTS "${triggerFn}"()`).execute(trx);
    });

    // Cleanup async după 60s (safety net — nu blochează răspunsul)
    setTimeout(async () => {
      try {
        await sql`DROP TABLE IF EXISTS ${sql.id(oldTable)}`.execute(db);
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.changelogTable)}`.execute(db);
      } catch {
        /* best-effort cleanup — nu aruncăm erori în background */
      }
    }, 60_000);
  }

  /**
   * Orchestrează întreg procesul Ghost DDL:
   *   createGhost → batchCopy → applyChangelog → atomicSwap
   *
   * onProgress primește (phase, detail) pentru logging/UI.
   */
  static async execute(
    db: Database,
    tableName: string,
    ddlStatements: string[],
    onProgress?: (phase: string, detail: string) => void,
  ): Promise<void> {
    onProgress?.('creating', `Creating ghost table and changelog trigger for "${tableName}"`);
    const migration = await GhostDDL.createGhost(db, tableName, ddlStatements);

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
  }
}
