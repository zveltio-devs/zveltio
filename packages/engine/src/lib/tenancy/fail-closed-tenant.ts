/**
 * The tenant fallback: what a query with no tenant context sees.
 *
 * Fail-closed is the default (DR-03, ADR 0053 decision 1): no tenant's rows.
 * The default is the database's own — migration 123 reads an ABSENT
 * `zveltio.fail_closed_tenant` as closed — so it holds on a connection this
 * step never touched. `ZVELTIO_FAIL_CLOSED_TENANT=0` is the opt-out: it stores
 * 'off' on the database (ALTER DATABASE … SET), and a contextless query sees
 * the default tenant's rows again. Removing the opt-out resets what it stored.
 *
 * Runs before the boot recycles the pool, so every connection the engine
 * serves with was opened after the database's setting was settled.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { modeValue } from '../operational-modes.js';

/** Values the functions in migration 123 read as "fall back to the default tenant". */
const OPEN = new Set(['off', 'false', '0']);

/** `ZVELTIO_FAIL_CLOSED_TENANT=0` opts out; anything else, unset included, is closed. */
export function failClosedTenantEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return modeValue('ZVELTIO_FAIL_CLOSED_TENANT', env)?.trim() !== '0';
}

/**
 * The values stored for this database that a new engine connection inherits:
 * the database's own, and the login role's (in this database or everywhere).
 */
async function storedValues(db: Database): Promise<string[]> {
  const r = await sql<{ v: string }>`
    SELECT substr(c, length('zveltio.fail_closed_tenant=') + 1) AS v
      FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c
     WHERE s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
       AND s.setrole IN (0, (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user))
       AND c LIKE 'zveltio.fail_closed_tenant=%'
  `.execute(db);
  return r.rows.map((row) => row.v);
}

const opens = (values: string[]) => values.some((v) => OPEN.has(v.trim().toLowerCase()));

export async function applyFailClosedTenantSetting(db: Database): Promise<void> {
  const enabled = failClosedTenantEnabled();
  const r = await sql<{ db: string }>`SELECT current_database() AS db`.execute(db);
  const dbName = r.rows[0]?.db;
  if (!dbName || !/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`unexpected database name ${JSON.stringify(dbName)}`);
  }

  if (!enabled) {
    try {
      await sql
        .raw(`ALTER DATABASE "${dbName}" SET zveltio.fail_closed_tenant = 'off'`)
        .execute(db);
    } catch (err) {
      // Not applied leaves the database closed: stricter than asked, never looser.
      console.warn(
        '[tenant] ZVELTIO_FAIL_CLOSED_TENANT=0 could not be applied, the fallback stays CLOSED:',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    console.warn(
      '⚠️  [tenant] ZVELTIO_FAIL_CLOSED_TENANT=0 — a query with no tenant context sees the ' +
        "DEFAULT tenant's rows instead of none (fail-open). Code that misses the tenant " +
        'context reads and writes the default tenant. Remove the variable to close it.',
    );
    return;
  }

  // Closed is the database's default; only a stored value can open it.
  const before = await storedValues(db);
  if (before.length === 0) return;
  try {
    // raw-ident-ok: dbName passed /^[a-zA-Z0-9_]+$/ at the top of this function.
    await sql.raw(`ALTER DATABASE "${dbName}" RESET zveltio.fail_closed_tenant`).execute(db);
  } catch (err) {
    // A stored 'on' (what ZVELTIO_FAIL_CLOSED_TENANT=1 wrote) is harmless to keep.
    if (!opens(before)) return;
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `zveltio.fail_closed_tenant is stored as 'off' and could not be reset (${why}). Run ` +
        'ALTER DATABASE <db> RESET zveltio.fail_closed_tenant as the database owner (the ' +
        'owner also needs GRANT SET ON PARAMETER zveltio.fail_closed_tenant; ' +
        'scripts/bootstrap-db-role.sh grants it), or set ZVELTIO_FAIL_CLOSED_TENANT=0 to keep it open.',
    );
  }
  // Asked for closed and still open — a value stored on the login role — is fatal:
  // booting fail-open is the opposite of what the operator runs, and a warning
  // scrolls past during a deploy.
  if (opens(await storedValues(db))) {
    throw new Error(
      `zveltio.fail_closed_tenant is stored as 'off' for the engine's login role. Run ` +
        'ALTER ROLE <role> [IN DATABASE <db>] RESET zveltio.fail_closed_tenant, or set ' +
        'ZVELTIO_FAIL_CLOSED_TENANT=0 to keep it open.',
    );
  }
}
