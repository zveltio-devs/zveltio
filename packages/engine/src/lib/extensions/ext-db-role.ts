/**
 * The Postgres role an inline extension's `ctx.db` statements run as.
 *
 * `assertWorkerSqlAllowed` reads every statement an extension sends, but for an
 * inline extension it was the ONLY thing between that SQL and the role
 * underneath, and the role underneath held far more than the analyzer permits.
 * Measured with the analyzer switched off (tests/harness/
 * extension-db-role.test.ts): inside a tenant transaction `ctx.db` ran as
 * `zveltio_rls`, which read `"user"` and `zv_api_keys` and could write
 * `zvd_permissions` — a `god` grant one analyzer miss away. On the pool it ran
 * as the engine's login role, on a stock install a SUPERUSER.
 *
 * `zveltio_ext` holds what the analyzer permits an extension and nothing else:
 *
 *   - every `zvd_*` table the engine did not create (collections, and the
 *     `zvd_*` tables extensions create — the analyzer admits both as user
 *     data). Collections created later are granted by `applyTenantRLS`, with the
 *     other narrow roles.
 *   - each loaded extension's own tables: the ones its migrations create or a
 *     grant names (`allowedTables`) and its `zv_<ext>_*` namespace — minus engine
 *     tables nobody granted, which the namespace rule alone would admit for an
 *     extension whose name prefixes one (`api` → `zv_api_keys`).
 *   - never `user` or a credential table, whatever the lists above say.
 *
 * NOSUPERUSER, NOBYPASSRLS, no CREATE on the schema: no DDL, and tenant
 * isolation binds it exactly as it binds `zveltio_rls`.
 *
 * It is one role for every inline extension, not one per extension: what keeps
 * extension A out of extension B's tables is still the analyzer. What this adds
 * is that a statement the analyzer gets wrong reaches extension data, never the
 * engine's — credentials, keys, tenants, the policy table.
 *
 * Only inside a tenant transaction, for now. On the pool (boot, cron, listeners
 * outside a request) `ctx.db` still runs as the engine role; switching there
 * changes which tenants a superuser install's background code sees, and that
 * is a decision, not a refactor.
 *
 * And `SET ROLE` is not a sandbox on its own: the session user can always
 * `RESET ROLE`. What makes it hold is that the analyzer refuses `SET`/`RESET`
 * and `set_config`, and that the engine sets the role again before every
 * statement and restores it after, so an escape could last one statement at
 * most — whose privileges Postgres has already checked when it starts.
 */

import { CompiledQuery, sql } from 'kysely';
import type { Database } from '../../db/index.js';

export const EXT_DB_ROLE = 'zveltio_ext';

/** Never granted to the extension role, whatever an allowlist says. */
const NEVER_GRANTED = ['user', 'session', 'account', 'verification', 'twoFactor', 'passkey'];

let _ready = false;
let _ensuring: Promise<boolean> | null = null;

/** Whether `ctx.db` switches into the extension role. False until the role is usable. */
export function extensionDbRoleReady(): boolean {
  return _ready;
}

/**
 * Create the role and make the engine a member, once per process. Best-effort,
 * as `ensureRlsEnforcementRole` is: where the engine may not create roles
 * (scripts/bootstrap-db-role.sh pre-creates it) or the membership is missing,
 * `ctx.db` keeps the role it had and says so once.
 */
export function ensureExtensionDbRole(db: Database): Promise<boolean> {
  _ensuring ??= (async () => {
    try {
      await sql`
        DO $ensure_ext_role$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_ext') THEN
            CREATE ROLE zveltio_ext NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
          END IF;
          IF NOT pg_has_role(current_user, 'zveltio_ext', 'MEMBER') THEN
            EXECUTE format('GRANT zveltio_ext TO %I', current_user);
          END IF;
          GRANT USAGE ON SCHEMA public TO zveltio_ext;
        END
        $ensure_ext_role$;
      `.execute(db);
      const r = await sql<{ ok: boolean }>`
        SELECT pg_has_role(current_user, 'zveltio_ext', 'MEMBER')
           AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'zveltio_ext')
           AS ok
      `.execute(db);
      _ready = Boolean(r.rows[0]?.ok);
    } catch (err) {
      console.warn(
        `[extensions] could not set up the ${EXT_DB_ROLE} role; ctx.db keeps the tenant ` +
          `role and the SQL analyzer is the only layer (continuing):`,
        (err as Error).message,
      );
      _ready = false;
    }
    return _ready;
  })();
  return _ensuring;
}

/**
 * Grant the extension role what this extension's `ctx.db` may reach. Runs after
 * the extension's migrations, so the tables exist; also sweeps every `zvd_*`
 * table the engine does not own, which covers collections that predate the role.
 * Idempotent: only relations the role cannot read yet are granted.
 */
export async function grantExtensionDbRole(
  db: Database,
  extName: string,
  allowedTables: ReadonlySet<string>,
): Promise<void> {
  if (!(await ensureExtensionDbRole(db))) return;
  try {
    const { engineOwnedTables } = await import('./register.js');
    const { ownedPrefixFor } = await import('./worker-sql-policy.js');
    const engine = [...(await engineOwnedTables())];
    const allowed = [...allowedTables].map((t) => t.toLowerCase());
    const prefix = ownedPrefixFor(extName).toLowerCase();
    const rows = await sql<{ rel: string; kind: string }>`
      WITH rels AS MATERIALIZED (
        SELECT c.oid, c.relname, c.relkind
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND NOT (c.relname = ANY(${NEVER_GRANTED}::text[]))
           AND (
             lower(c.relname) = ANY(${allowed}::text[])
             OR (NOT (lower(c.relname) = ANY(${engine}::text[]))
                 AND (left(c.relname, 4) = 'zvd_'
                      OR left(lower(c.relname), ${prefix.length}::int) = ${prefix}::text))
           )
      )
      SELECT relname AS rel, 'table' AS kind FROM rels
       WHERE NOT has_table_privilege(${EXT_DB_ROLE}::text, oid, 'SELECT')
      UNION ALL
      SELECT s.relname, 'sequence' FROM rels
        JOIN pg_depend d ON d.refobjid = rels.oid AND d.classid = 'pg_class'::regclass
                        AND d.deptype IN ('a', 'i')
        JOIN pg_class s ON s.oid = d.objid
       -- CASE, not AND: the planner may test the privilege before the kind, and
       -- has_sequence_privilege raises on a TOAST table.
       WHERE CASE WHEN s.relkind = 'S'
                  THEN NOT has_sequence_privilege(${EXT_DB_ROLE}::text, s.oid, 'USAGE') END
    `.execute(db);
    for (const { rel, kind } of rows.rows) {
      const privs = kind === 'table' ? 'SELECT, INSERT, UPDATE, DELETE' : 'USAGE, SELECT';
      const on = kind === 'table' ? sql`TABLE` : sql`SEQUENCE`;
      await sql`GRANT ${sql.raw(privs)} ON ${on} ${sql.table(`public.${rel}`)} TO ${sql.id(EXT_DB_ROLE)}`.execute(
        db,
      );
    }
  } catch (err) {
    console.warn(
      `[extensions] "${extName}": granting its tables to ${EXT_DB_ROLE} failed (continuing):`,
      (err as Error).message,
    );
  }
}

/** The part of Kysely's QueryExecutor this file drives. */
interface RoleExecutor {
  executeQuery(query: CompiledQuery): Promise<{ rows: unknown[] }>;
}

/** The last role window queued on each transaction; see `asExtensionDbRole`. */
const windows = new WeakMap<object, Promise<unknown>>();

/**
 * Run one extension statement as the extension role, on the transaction
 * connection `executor` is bound to, and put the previous role back after it.
 *
 * `SET LOCAL` semantics through `set_config(…, true)`: whatever happens it ends
 * with the transaction, and a savepoint rollback (`ctx.db.transaction()`) undoes
 * it too. The previous role is read in the same round trip that sets the new
 * one — target-list order — so the cost is two round trips per statement.
 *
 * Windows on one transaction (`trx`) run one at a time. Extensions issue
 * `Promise.all([ctx.db…, ctx.db…])` on the request transaction, and two
 * interleaved windows would read each other's role as "previous" and hand the
 * engine back `zveltio_ext` — or hand an extension statement `zveltio_rls`.
 * An ENGINE statement sent concurrently can still land inside a window and run
 * as the narrower role: it may fail, it cannot gain anything.
 */
export function asExtensionDbRole<T>(
  trx: object,
  executor: RoleExecutor,
  run: () => Promise<T>,
): Promise<T> {
  if (!_ready) return run();
  const mine = (windows.get(trx) ?? Promise.resolve()).then(() => roleWindow(executor, run));
  windows.set(
    trx,
    mine.catch(() => undefined),
  );
  return mine;
}

async function roleWindow<T>(executor: RoleExecutor, run: () => Promise<T>): Promise<T> {
  const set = await executor.executeQuery(
    CompiledQuery.raw(
      `SELECT current_setting('role') AS prev, set_config('role', '${EXT_DB_ROLE}', true) AS now`,
    ),
  );
  const prev = String((set.rows[0] as { prev?: string } | undefined)?.prev ?? 'none');
  const restore = () =>
    executor.executeQuery(CompiledQuery.raw(`SELECT set_config('role', $1, true)`, [prev]));
  let out: T;
  try {
    out = await run();
  } catch (err) {
    // The statement failed, so the transaction (or the savepoint around it) is
    // aborted and its rollback restores the role; a restore here would only
    // add 25P02 to the original error.
    await restore().catch(() => undefined);
    throw err;
  }
  await restore();
  return out;
}

/** Test seam: forget the role state so a test can set it up again. */
export function _resetExtensionDbRoleForTests(): void {
  _ready = false;
  _ensuring = null;
}
