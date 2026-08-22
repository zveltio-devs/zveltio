/**
 * Apply ZVELTIO_FAIL_CLOSED_TENANT=1 as a database-level GUC so every
 * connection (including zveltio_rls) sees fail-closed tenant predicates.
 *
 * When the flag is unset/off, reset the GUC to default so toggling works
 * across restarts without manual ALTER DATABASE.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export async function applyFailClosedTenantSetting(db: Database): Promise<void> {
  const enabled = process.env.ZVELTIO_FAIL_CLOSED_TENANT === '1';
  try {
    const r = await sql<{ db: string }>`SELECT current_database() AS db`.execute(db);
    const dbName = r.rows[0]?.db;
    if (!dbName || !/^[a-zA-Z0-9_]+$/.test(dbName)) {
      console.warn('[tenant] skip fail-closed GUC — unexpected database name');
      return;
    }
    if (enabled) {
      await sql.raw(`ALTER DATABASE "${dbName}" SET zveltio.fail_closed_tenant = 'on'`).execute(db);
      // Also set on this session so boot-time queries see it immediately.
      await sql`SELECT set_config('zveltio.fail_closed_tenant', 'on', false)`.execute(db);
      console.warn(
        '⚠️  [tenant] ZVELTIO_FAIL_CLOSED_TENANT=1 — contextless queries see ZERO rows ' +
          '(fail-closed). Ensure every path sets zveltio.current_tenant or uses a ' +
          'privileged role. Single-tenant installs should leave this unset.',
      );
    } else {
      await sql.raw(`ALTER DATABASE "${dbName}" RESET zveltio.fail_closed_tenant`).execute(db);
      await sql`SELECT set_config('zveltio.fail_closed_tenant', 'off', false)`.execute(db);
    }
  } catch (err) {
    console.warn(
      '[tenant] could not apply fail-closed GUC:',
      err instanceof Error ? err.message : err,
    );
  }
}
