/**
 * The contract half of migration 048, as a boot reconciler rather than a
 * migration.
 *
 * 048 converged `zv_import_logs` on the `data/import` vocabulary but only
 * EXPANDED: it added the extension's columns and carried the engine-era data
 * across, leaving `file_format`, `processed_rows`, `success_rows`, `error_rows`
 * and `options` in place. Dropping them belongs to a later release, because
 * during an upgrade an instance still running the previous engine serves
 * `/api/import`, reads those columns and writes status `processing`. That is
 * not hypothetical here: `charts/zveltio/templates/migration-job.yaml` is a
 * Helm `pre-upgrade` hook, so migrations run BEFORE the Deployment rolls, and
 * the chart documents `engine.replicaCount > 2`.
 *
 * Why this is not migration 049. A migration runs once and is then recorded as
 * applied. The moment it may safely run is not the moment it would execute —
 * it is whenever the operator's fleet has finished moving past the engine that
 * still serves `/api/import`, which no SQL can detect and which is different
 * for every deployment. A one-shot migration gated on a flag would simply
 * record itself as done on the boot where the flag happened to be unset.
 *
 * So it is idempotent and runs every boot, like `reconcileExtensionTenantRLS`,
 * and does nothing until an operator says the fleet is ready:
 *
 *     ZVELTIO_IMPORT_LOGS_CONTRACT=1
 *
 * Same shape as ZVELTIO_FAIL_CLOSED_TENANT (migration 047): the engine cannot
 * know when the operator's rollout is finished, so the operator says so.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

/** The engine-era columns 048 deliberately left behind. */
const DEAD_COLUMNS = [
  'file_format',
  'processed_rows',
  'success_rows',
  'error_rows',
  'options',
] as const;

/**
 * Drop the columns migration 048 left for a later release.
 *
 * Returns the number of columns dropped — 0 when the opt-in is absent, when
 * they are already gone, or when the table does not exist.
 */
export async function contractImportLogs(db: Database): Promise<number> {
  if (process.env.ZVELTIO_IMPORT_LOGS_CONTRACT !== '1') return 0;

  let present: string[];
  try {
    const rows = await sql<{ column_name: string }>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'zv_import_logs'
         AND column_name = ANY(${sql.val(DEAD_COLUMNS as unknown as string[])})
    `.execute(db);
    present = rows.rows.map((r) => r.column_name);
  } catch (err) {
    // Not fatal, and deliberately not silent: an operator who set the flag is
    // waiting for this to happen and would otherwise see nothing either way.
    console.warn(
      '[import-logs-contract] could not inspect zv_import_logs (skipping):',
      (err as Error).message,
    );
    return 0;
  }

  if (present.length === 0) return 0;

  let dropped = 0;
  for (const col of present) {
    // One statement per column rather than one ALTER with five clauses: a
    // column that fails to drop should not take the other four with it, and
    // the next boot retries only what is left.
    // `col` came back from the query above, which filters on DEAD_COLUMNS, so
    // it can only be one of five literals in this file — not a name from
    // anywhere a caller could reach. Asserted rather than assumed, because the
    // value is interpolated.
    if (!(DEAD_COLUMNS as readonly string[]).includes(col)) continue;
    try {
      await sql.raw(`ALTER TABLE zv_import_logs DROP COLUMN IF EXISTS "${col}"`).execute(db);
      dropped++;
    } catch (err) {
      console.warn(
        `[import-logs-contract] could not drop zv_import_logs.${col}:`,
        (err as Error).message,
      );
    }
  }

  if (dropped > 0) {
    console.warn(
      `⚠️  [import-logs-contract] dropped ${dropped} engine-era column(s) from ` +
        `zv_import_logs (${present.join(', ')}). An engine older than this one can no ` +
        'longer serve /api/import against this database — which is what ' +
        'ZVELTIO_IMPORT_LOGS_CONTRACT=1 asserts is already true.',
    );
  }
  return dropped;
}
