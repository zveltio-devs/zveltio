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
 * The catalog is not the whole answer: a role's value wins over the
 * database's, and the client's startup options (`options=-c …` in DATABASE_URL,
 * PGOPTIONS) win over both without appearing in any catalog. So the step ends
 * by opening one new connection (over NATIVE_DATABASE_URL when set) and
 * reading what it gets; a difference
 * from what ZVELTIO_FAIL_CLOSED_TENANT asks warns in development and test and
 * refuses to boot in production (owner 2026-11-21). Any other `zveltio.*`
 * setting the database reads, preset on that connection, refuses the boot in
 * every environment. A `=0` the engine role cannot store refuses it in
 * production too.
 */

import { sql } from 'kysely';
import { createDb, type Database, withIdleInTransactionTimeout } from '../../db/index.js';
import { isProduction, modeValue } from '../operational-modes.js';

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

const FCT = 'zveltio.fail_closed_tenant';

/** Every schema but Postgres' own. */
const USER_NS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;

/**
 * What a connection opened now gets, read on ONE new connection from `url` with
 * the engine's driver and options, closed after.
 *
 * `open`: whether it falls back to the default tenant, read the way migration
 * 123's functions read it. `preset`: every other `zveltio.*` setting this
 * database reads — in a function, policy, column default, CHECK constraint,
 * view or rule, index or trigger condition — that already holds a value. Those
 * are the engine's per-transaction context (tenant, actor, grants); the names
 * come from the database itself, because a placeholder setting appears in no
 * catalog (pg_settings omits it) and a hand-kept list would miss the next one.
 */
async function freshConnection(url: string): Promise<{ open: boolean; preset: string[] }> {
  const probe = createDb(withIdleInTransactionTimeout(url), 1);
  try {
    // `[.]`, not an escaped dot: a template literal cooks `\.` to `.`.
    const r = await sql<{ open: boolean; preset: string[] | null }>`
      WITH src AS (
        SELECT p.prosrc AS t FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${sql.raw(USER_NS)}
        UNION ALL
        SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_catalog.pg_policies
        UNION ALL
        SELECT pg_catalog.pg_get_expr(adbin, adrelid) FROM pg_catalog.pg_attrdef
        UNION ALL
        SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
         WHERE c.contype = 'c' AND ${sql.raw(USER_NS)}
        UNION ALL
        SELECT pg_catalog.pg_get_ruledef(w.oid) FROM pg_catalog.pg_rewrite w
          JOIN pg_catalog.pg_class k ON k.oid = w.ev_class
          JOIN pg_catalog.pg_namespace n ON n.oid = k.relnamespace WHERE ${sql.raw(USER_NS)}
        UNION ALL
        SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class k ON k.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = k.relnamespace
         WHERE (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL) AND ${sql.raw(USER_NS)}
        UNION ALL
        SELECT pg_catalog.pg_get_triggerdef(t.oid) FROM pg_catalog.pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgqual IS NOT NULL
      ), names AS (
        SELECT DISTINCT 'zveltio.' || m[1] AS name
          FROM src, regexp_matches(src.t, 'zveltio[.]([a-z_][a-z0-9_]*)', 'g') AS m
      )
      SELECT lower(coalesce(nullif(current_setting(${FCT}, true), ''), 'on'))
               IN ('off', 'false', '0') AS open,
             (SELECT array_agg(name ORDER BY name) FROM names
               WHERE name <> ${FCT} AND coalesce(current_setting(name, true), '') <> '') AS preset
    `.execute(probe);
    return { open: r.rows[0]?.open === true, preset: r.rows[0]?.preset ?? [] };
  } finally {
    await probe.destroy();
  }
}

/** `zveltio.*` names a libpq options string sets (`-c name=…`, `--name=…`), URL-encoded or not. */
export function startupOptionNames(text: string): string[] {
  let plain = text;
  try {
    plain = decodeURIComponent(text);
  } catch {
    // Not encoded, or malformed: read it as written.
  }
  const names = [...plain.matchAll(/(?:-c[\s+]*|--)zveltio[.]([a-z_][a-z0-9_]*)[\s+]*=/g)];
  return [...new Set(names.map((m) => `zveltio.${m[1]}`))];
}

/**
 * `url` is the engine's DATABASE_URL; `directUrl`, its NATIVE_DATABASE_URL.
 * Past a transaction pooler a "new" connection is whatever backend the pooler
 * hands out — opened before the setting was stored, or carrying another
 * client's SET — so with a direct URL the fresh connection is opened there,
 * and the engine URL's own startup options (and PGOPTIONS) are read as text:
 * the probe cannot see what a pooler does with them.
 */
export async function applyFailClosedTenantSetting(
  db: Database,
  url: string,
  directUrl?: string,
): Promise<void> {
  const enabled = failClosedTenantEnabled();
  await storeSetting(db, enabled);
  const fresh = await freshConnection(directUrl || url);
  const named = directUrl ? startupOptionNames(`${url} ${process.env.PGOPTIONS ?? ''}`) : [];
  const preset = [...new Set([...fresh.preset, ...named.filter((n) => n !== FCT)])].sort();
  // Never a mode, in any environment: a contextless statement would run as
  // whatever tenant, actor or grant the connection was handed.
  if (preset.length > 0) {
    throw new Error(
      `a new connection already carries ${preset.join(', ')}: the engine's ` +
        'per-transaction context, preset for every statement on the connection (a ' +
        'preset zveltio.current_tenant runs contextless queries as that tenant). Remove it ' +
        "from options=-c in DATABASE_URL, PGOPTIONS, or the login role's or database's settings.",
    );
  }
  const problems: string[] = [];
  if (fresh.open === enabled) {
    problems.push(
      enabled
        ? "a new connection's zveltio.fail_closed_tenant is fail-open although " +
            'ZVELTIO_FAIL_CLOSED_TENANT does not ask for it: a query with no tenant context sees ' +
            "the DEFAULT tenant's rows. Something the boot does not store sets it — " +
            "options=-c zveltio.fail_closed_tenant=… in DATABASE_URL, PGOPTIONS, or the login role's " +
            'setting. Remove it.'
        : "a new connection's zveltio.fail_closed_tenant is closed although " +
            "ZVELTIO_FAIL_CLOSED_TENANT=0 asks for the default tenant's rows: options=-c in " +
            "DATABASE_URL, PGOPTIONS or the login role's setting overrides the database's 'off' " +
            '(or the boot could not store it — warned above). Remove the override, or the variable.',
    );
  }
  if (named.includes(FCT)) {
    problems.push(
      'DATABASE_URL or PGOPTIONS sets zveltio.fail_closed_tenant, which the check over ' +
        'NATIVE_DATABASE_URL cannot see applied. ZVELTIO_FAIL_CLOSED_TENANT is the one switch: remove it.',
    );
  }
  for (const problem of problems) {
    if (isProduction()) throw new Error(problem);
    console.warn(`⚠️  [tenant] ${problem}`);
  }
}

/**
 * Stores (or resets) the database's own value; what a connection gets is checked
 * after. Exported for the unit tests, which have no database to probe.
 */
export async function storeSetting(db: Database, enabled: boolean): Promise<void> {
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
      // Not stored leaves the database closed — stricter than asked — but the
      // operator asked for something the boot did not do: production refuses.
      const why = err instanceof Error ? err.message : String(err);
      const problem =
        `ZVELTIO_FAIL_CLOSED_TENANT=0 could not be stored (${why}), the fallback stays CLOSED. ` +
        'The engine role must own the database and hold GRANT SET ON PARAMETER ' +
        'zveltio.fail_closed_tenant (scripts/bootstrap-db-role.sh grants both); or remove the variable.';
      if (isProduction()) throw new Error(problem);
      console.warn(`[tenant] ${problem}`);
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
