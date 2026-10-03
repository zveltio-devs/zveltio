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
 * The role holds what the analyzer permits an extension and nothing else:
 *
 *   - every `zvd_*` table the engine did not create (collections, and the
 *     `zvd_*` tables extensions create — the analyzer admits both as user
 *     data), on `zveltio_ext`. Collections created later are granted by
 *     `applyTenantRLS`, with the other narrow roles.
 *   - the extension's own tables: the ones its migrations create or a grant
 *     names (`allowedTables`) and its `zv_<ext>_*` namespace — minus engine
 *     tables nobody granted, which the namespace rule alone would admit for an
 *     extension whose name prefixes one (`api` → `zv_api_keys`), and minus the
 *     namespace of an extension with a longer prefix (`a` → `zv_a_b_*`).
 *   - never `user` or a credential table, whatever the lists above say.
 *
 * NOSUPERUSER, NOBYPASSRLS, no CREATE on the schema: no DDL, and tenant
 * isolation binds it exactly as it binds `zveltio_rls`.
 *
 * And one role PER EXTENSION underneath it, where the engine may create roles
 * (`_perExtension`). It was one role for every inline extension, so extension A
 * reached extension B's tables at the database layer and only the analyzer kept
 * them apart. Now each extension's statements run as its own role
 * (`extensionDbRoleNames`), which holds that extension's tables and is a member
 * of `zveltio_ext` for what every extension shares: collections and USAGE on the
 * schema. Worker extensions get the same under `zveltio_worker`. Disable revokes
 * an extension role's grants and membership, uninstall drops it
 * (`revokeExtensionDbRoles`).
 *
 * Where the engine may not create roles (a hand-made engine role without
 * CREATEROLE and ADMIN on the parents) everything stays on the shared roles,
 * and boot says so once: a statement the analyzer gets wrong reaches extension
 * data, never the engine's.
 *
 * On the pool too — boot, cron, listeners, background work and `ctx.adminDb` —
 * where it used to run as the engine's login role, a SUPERUSER on a stock
 * install: each statement there runs in a short transaction of its own that
 * sets the role first (`asExtensionDbRoleOnPool`). Without changing which
 * tenants that code sees: a role that bypasses RLS gets the extension role's
 * BYPASSRLS twin — a member of it, so exactly its privileges, plus BYPASSRLS
 * (`zveltio_ext_bypass` over `zveltio_ext` on the shared layout) — and a role
 * RLS binds gets the plain one. The twin exists only where the engine itself
 * bypasses RLS; handing it to a plain role would be the escalation.
 *
 * And `SET ROLE` is not a sandbox on its own: the session user can always
 * `RESET ROLE`. What makes it hold is that the analyzer refuses `SET`/`RESET`
 * and `set_config`, and that the engine sets the role again before every
 * statement and restores it after, so an escape could last one statement at
 * most — whose privileges Postgres has already checked when it starts.
 */

import { createHash } from 'node:crypto';
import { CompiledQuery, type ConnectionProvider, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { keepWorkerExtensionTables, temporaryObjectsRestricted } from '../tenancy/index.js';

export const EXT_DB_ROLE = 'zveltio_ext';
/** `zveltio_ext` plus BYPASSRLS, for statements whose role already bypasses RLS. */
export const EXT_BYPASS_DB_ROLE = 'zveltio_ext_bypass';
const WORKER_DB_ROLE = 'zveltio_worker';

/** Never granted to the extension role, whatever an allowlist says. */
const NEVER_GRANTED = ['user', 'session', 'account', 'verification', 'twoFactor', 'passkey'];

let _ready = false;
/** The engine's login role is a superuser or BYPASSRLS. */
let _loginBypasses = false;
let _bypassReady = false;
/** The engine may create roles and hand out `zveltio_ext`: one role per extension. */
let _perExtension = false;
let _dbName: string | null = null;
let _ensuring: Promise<boolean> | null = null;
let _workerNarrowed = false;

/** Each loaded inline extension's own role and its BYPASSRLS twin (null: none). */
const extRoles = new Map<string, { role: string; bypass: string | null }>();
/** Each loaded worker extension's own role, for the SQL bridge. */
const workerRoles = new Map<string, string>();

/**
 * One extension's roles in one database. Role names are cluster-wide and at most
 * 63 bytes: a readable stem plus a hash of the database and the exact name, so
 * `a/b` and `a_b` never share a role, and neither do two databases on one
 * cluster — grants are per database but memberships are not, so a shared role
 * could not be revoked or dropped in one database without the other.
 * Characters are `[a-z0-9_]` only, which is what lets the role window inline them.
 */
export function extensionDbRoleNames(
  dbName: string,
  extName: string,
): { role: string; bypass: string; worker: string } {
  const stem = extName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 38);
  const h = createHash('sha256').update(`${dbName}\0${extName}`).digest('hex').slice(0, 10);
  return {
    role: `zveltio_ext_${stem}_${h}`,
    bypass: `zveltio_extb_${stem}_${h}`,
    worker: `zveltio_wrk_${stem}_${h}`,
  };
}

async function currentDbName(db: Database): Promise<string> {
  _dbName ??= (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d;
  return _dbName;
}

/** The role the worker SQL bridge runs this extension's queries as, when it has its own. */
export function workerDbRoleFor(extName: string): string | undefined {
  return workerRoles.get(extName);
}

/**
 * Create `name` (once), let the engine SET it, and make it inherit `parent`.
 * Concurrent replicas may race on CREATE; the read-back is what decides, and a
 * role that is not exactly what we would have made (a superuser, a wrong
 * BYPASSRLS bit) is refused rather than used.
 */
async function ensureRole(
  db: Database,
  name: string,
  parent: string,
  bypassrls: boolean,
): Promise<boolean> {
  if (!/^[a-z0-9_]{1,63}$/.test(name) || !/^[a-z0-9_]{1,63}$/.test(parent)) return false;
  // Replicas booting together race on the same CREATE and GRANTs; the loser's
  // retry finds them made.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await ensureRoleOnce(db, name, parent, bypassrls)) return true;
  }
  return false;
}

async function ensureRoleOnce(
  db: Database,
  name: string,
  parent: string,
  bypassrls: boolean,
): Promise<boolean> {
  try {
    await sql
      .raw(`
        DO $ensure_role$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
            BEGIN
              CREATE ROLE ${name} NOLOGIN NOSUPERUSER ${bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'}
                NOCREATEDB NOCREATEROLE;
            EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
            END;
          END IF;
          IF NOT pg_has_role(current_user, '${name}', 'SET') THEN
            EXECUTE format('GRANT ${name} TO %I WITH SET TRUE', current_user);
          END IF;
          IF NOT pg_has_role('${name}', '${parent}', 'USAGE') THEN
            GRANT ${parent} TO ${name} WITH INHERIT TRUE;
          END IF;
        END
        $ensure_role$;
      `)
      .execute(db);
    const r = await sql<{ ok: boolean }>`
      SELECT pg_has_role(current_user, ${name}, 'SET')
         AND pg_has_role(${name}, ${parent}, 'USAGE')
         AND (SELECT NOT rolsuper AND rolbypassrls = ${bypassrls}
                FROM pg_roles WHERE rolname = ${name}) AS ok
    `.execute(db);
    if (r.rows[0]?.ok) return true;
  } catch (err) {
    console.warn(`[extensions] could not set up role ${name}:`, (err as Error).message);
  }
  return false;
}

/**
 * Whether the engine can make per-extension roles under `parent`: create roles,
 * and grant `parent` to them. A superuser can; so can CREATEROLE with ADMIN on
 * `parent`, which Postgres gives the role that created it and the bootstrap
 * script grants.
 */
async function canMakeRolesUnder(db: Database, parent: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user)
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${parent})
       AND pg_has_role(current_user, ${parent}, 'MEMBER WITH ADMIN OPTION') AS ok
  `.execute(db);
  return Boolean(r.rows[0]?.ok);
}

/**
 * With per-extension roles a shared role keeps what every extension shares —
 * collections and other `zvd_*` data — and nothing else. Every other relation it
 * holds is a grant from before per-extension roles, disabled extensions'
 * included, so it goes. Once per process.
 */
async function narrowSharedRole(db: Database, role: string): Promise<void> {
  try {
    const held = await sql<{ rel: string; seq: boolean }>`
      SELECT c.relname AS rel, c.relkind = 'S' AS seq
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_roles r ON r.rolname = ${role}
       WHERE left(c.relname, 4) <> 'zvd_'
         AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = r.oid)
    `.execute(db);
    for (const { rel, seq } of held.rows) {
      await retryConcurrentUpdate(() =>
        sql`REVOKE ALL ON ${seq ? sql`SEQUENCE` : sql`TABLE`} ${sql.table(`public.${rel}`)} FROM ${sql.id(role)}`.execute(
          db,
        ),
      );
    }
  } catch (err) {
    console.warn(`[extensions] narrowing ${role} failed (continuing):`, (err as Error).message);
  }
}

/** Whether `ctx.db` switches into the extension role. False until the role is usable. */
export function extensionDbRoleReady(): boolean {
  return _ready;
}

/**
 * Create the role and make the engine a member, once per process. Best-effort,
 * as `ensureRlsEnforcementRole` is: where the engine may not create roles
 * (scripts/bootstrap-db-role.sh pre-creates it) or the membership is missing,
 * `ctx.db` keeps the role it had and says so once.
 *
 * Membership is tested with SET, not MEMBER: an engine with CREATEROLE that
 * creates the role holds it WITH ADMIN but SET FALSE, MEMBER
 * answers true, and every `set_config('role', …)` then failed mid-request with
 * "permission denied to set role".
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
          IF NOT pg_has_role(current_user, 'zveltio_ext', 'SET') THEN
            EXECUTE format('GRANT zveltio_ext TO %I WITH SET TRUE', current_user);
          END IF;
          GRANT USAGE ON SCHEMA public TO zveltio_ext;
        END
        $ensure_ext_role$;
      `.execute(db);
      const r = await sql<{ ok: boolean; bypasses: boolean }>`
        SELECT pg_has_role(current_user, 'zveltio_ext', 'SET')
           AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'zveltio_ext')
           AS ok,
           (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses
      `.execute(db);
      _ready = Boolean(r.rows[0]?.ok);
      _loginBypasses = Boolean(r.rows[0]?.bypasses);
    } catch (err) {
      console.warn(
        `[extensions] could not set up the ${EXT_DB_ROLE} role; ctx.db keeps the tenant ` +
          `role and the SQL analyzer is the only layer (continuing):`,
        (err as Error).message,
      );
      _ready = false;
    }
    _bypassReady = _ready && _loginBypasses && (await ensureBypassTwin(db));
    _perExtension = _ready && (await canMakeRolesUnder(db, EXT_DB_ROLE).catch(() => false));
    if (_perExtension) await narrowSharedRole(db, EXT_DB_ROLE);
    else if (_ready) warnSharedRole();
    return _ready;
  })();
  return _ensuring;
}

/** Once per process: every extension runs on the shared role. */
function warnSharedRole(): void {
  console.warn(
    `[extensions] all extensions share one database role (${EXT_DB_ROLE}, ${WORKER_DB_ROLE}): ` +
      `the engine role cannot create roles under them (CREATEROLE with ADMIN on both), so only ` +
      `the SQL analyzer keeps one extension out of another's tables. ` +
      'Re-run scripts/bootstrap-db-role.sh, which grants both.',
  );
}

/**
 * The twin, where the engine role bypasses RLS. Its privileges are a membership
 * in `zveltio_ext`, not grants of its own, so the two cannot drift apart: every
 * grant site (load, `applyTenantRLS`, the boot revoke) names `zveltio_ext` only.
 *
 * Creating a BYPASSRLS role takes a superuser, or BYPASSRLS + CREATEROLE. Where
 * it cannot be made, pool statements keep the engine role — narrowing them to
 * `zveltio_ext` would change which tenants they see.
 */
async function ensureBypassTwin(db: Database): Promise<boolean> {
  try {
    await sql`
      DO $ensure_ext_bypass$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_ext_bypass') THEN
          CREATE ROLE zveltio_ext_bypass NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
        IF NOT pg_has_role(current_user, 'zveltio_ext_bypass', 'SET') THEN
          EXECUTE format('GRANT zveltio_ext_bypass TO %I WITH SET TRUE', current_user);
        END IF;
        IF NOT pg_has_role('zveltio_ext_bypass', 'zveltio_ext', 'USAGE') THEN
          GRANT zveltio_ext TO zveltio_ext_bypass WITH INHERIT TRUE;
        END IF;
      END
      $ensure_ext_bypass$;
    `.execute(db);
    const r = await sql<{ ok: boolean }>`
      SELECT pg_has_role(current_user, 'zveltio_ext_bypass', 'SET')
         AND pg_has_role('zveltio_ext_bypass', 'zveltio_ext', 'USAGE')
         AND (SELECT rolbypassrls AND NOT rolsuper FROM pg_roles
               WHERE rolname = 'zveltio_ext_bypass') AS ok
    `.execute(db);
    if (r.rows[0]?.ok) return true;
  } catch (err) {
    console.warn(`[extensions] could not set up ${EXT_BYPASS_DB_ROLE}:`, (err as Error).message);
  }
  console.warn(
    `[extensions] the engine role bypasses RLS and ${EXT_BYPASS_DB_ROLE} is not usable; ` +
      `ctx.db on the pool and ctx.adminDb keep the engine role (continuing)`,
  );
  return false;
}

/**
 * Grant the extension role what this extension's `ctx.db` may reach. Runs after
 * the extension's migrations, so the tables exist — and migrations are the only
 * place an extension table is born: `ctx.db` and the worker bridge refuse DDL in
 * the analyzer, the roles hold no CREATE on the schema, and `ctx.DDLManager`
 * creates collections only (`zvd_*`, granted by `applyTenantRLS`). Also sweeps
 * every `zvd_*` table the engine does not own onto `zveltio_ext`, which covers
 * collections that predate the role. Idempotent.
 */
export async function grantExtensionDbRole(
  db: Database,
  extName: string,
  allowedTables: ReadonlySet<string>,
): Promise<void> {
  if (!(await ensureExtensionDbRole(db))) return;
  if (!_perExtension) {
    await grantOwnTables(db, extName, allowedTables, true, EXT_DB_ROLE, EXT_DB_ROLE);
    return;
  }
  const names = extensionDbRoleNames(await currentDbName(db), extName);
  const own = (await ensureRole(db, names.role, EXT_DB_ROLE, false)) ? names.role : null;
  // The twin only where the engine bypasses RLS, as `zveltio_ext_bypass`.
  const bypass =
    own && _loginBypasses && (await ensureRole(db, names.bypass, own, true)) ? names.bypass : null;
  // A role that could not be made leaves the extension on `zveltio_ext`, which
  // holds none of its tables: its own queries fail, they never widen.
  if (own) extRoles.set(extName, { role: own, bypass });
  else extRoles.delete(extName);
  await grantOwnTables(db, extName, allowedTables, true, EXT_DB_ROLE, own);
}

/**
 * Grant the worker SQL bridge's role this worker-isolated extension's own
 * tables: its `zv_<ext>_*` namespace and the `zvd_*` tables its migrations
 * create, never an engine table — exactly what the bridge's analyzer admits
 * beyond collections. Not `EXTENSION_TABLE_GRANTS`: the bridge passes the
 * analyzer no grants. The role is the extension's own under `zveltio_worker`
 * where the engine can make one, else `zveltio_worker` itself.
 */
export async function grantWorkerDbRole(
  db: Database,
  extName: string,
  allowedTables: ReadonlySet<string>,
): Promise<void> {
  let perExtension = false;
  try {
    // The bridge picks the role when it exists; absent (001 could not create
    // it), it falls back to `zveltio_rls` and there is nothing to grant.
    // SET, as the bridge's own pick (pickWorkerSqlRole): a role it cannot switch
    // to is one it does not use.
    const r = await sql<{ member: boolean }>`
      SELECT pg_has_role(current_user, oid, 'SET') AS member
        FROM pg_roles WHERE rolname = ${WORKER_DB_ROLE}
    `.execute(db);
    if (!r.rows[0]?.member) return;
    // 001's grant of this sits in a block a pre-created role fails (scripts/
    // bootstrap-db-role.sh: re-granting membership needs ADMIN); PUBLIC holds it
    // on a stock schema, not on one hardened by revoking that.
    await sql`GRANT USAGE ON SCHEMA public TO ${sql.id(WORKER_DB_ROLE)}`.execute(db);
    perExtension = await canMakeRolesUnder(db, WORKER_DB_ROLE);
  } catch (err) {
    console.warn(
      `[extensions] "${extName}": ${WORKER_DB_ROLE} not usable (continuing):`,
      (err as Error).message,
    );
    return;
  }
  if (!perExtension) {
    // Loaded worker extensions' tables survive the boot revoke of non-collections.
    keepWorkerExtensionTables(
      await grantOwnTables(db, extName, allowedTables, false, WORKER_DB_ROLE, WORKER_DB_ROLE),
    );
    return;
  }
  if (!_workerNarrowed) {
    _workerNarrowed = true;
    await narrowSharedRole(db, WORKER_DB_ROLE);
  }
  const name = extensionDbRoleNames(await currentDbName(db), extName).worker;
  const own = (await ensureRole(db, name, WORKER_DB_ROLE, false)) ? name : null;
  if (own) workerRoles.set(extName, own);
  else workerRoles.delete(extName);
  await grantOwnTables(db, extName, allowedTables, false, WORKER_DB_ROLE, own);
}

/** Every extension name `zv_extension_registry` knows, installed or not. */
async function installedExtensionNames(db: Database): Promise<string[]> {
  try {
    const r = await sql<{ name: string }>`SELECT DISTINCT name FROM zv_extension_registry`.execute(
      db,
    );
    return r.rows.map((x) => x.name);
  } catch {
    return [];
  }
}

/**
 * Grant this extension's relations (tables and their sequences) to `own`, and
 * every `zvd_*` table the engine does not own to `shared` (inline only); returns
 * every relation that way, granted now or before.
 *
 * The extension's own: the tables a grant or its migrations name (`allowedTables`
 * — for a worker extension only its `zvd_*` ones) and its `zv_<ext>_*` namespace
 * minus engine tables and minus the namespace of any known extension with a
 * LONGER prefix (`a` stops at `zv_a_b_*` once `a/b` exists; the analyzer applies
 * the same rule, `ownsByPrefix`).
 *
 * With per-extension roles (`own` is not `shared`) a shorter-prefixed
 * extension's role gives up this extension's namespace. `own` null: the role
 * could not be made, so nothing of the extension's is granted anywhere.
 */
async function grantOwnTables(
  db: Database,
  extName: string,
  allowedTables: ReadonlySet<string>,
  inline: boolean,
  shared: string,
  own: string | null,
): Promise<string[]> {
  try {
    const { engineOwnedTables } = await import('./register.js');
    const { coveringExtensionNames, longerOwnedPrefixes, noteExtensionNames, ownedPrefixFor } =
      await import('./worker-sql-policy.js');
    // Installed, not only loaded: `a/b`'s tables stay `a/b`'s while it is
    // disabled, and another replica may have installed it.
    noteExtensionNames([extName, ...(await installedExtensionNames(db))]);
    const engine = [...(await engineOwnedTables())];
    const allowed = [...allowedTables].map((t) => t.toLowerCase());
    const prefix = ownedPrefixFor(extName).toLowerCase();
    const longer = longerOwnedPrefixes(extName);
    const perExtension = own !== shared;
    // The roles of the extensions whose prefix is a strict prefix of this one's.
    const covering: string[] = [];
    if (perExtension && own) {
      const dbName = await currentDbName(db);
      for (const c of coveringExtensionNames(extName)) {
        const n = extensionDbRoleNames(dbName, c);
        covering.push(inline ? n.role : n.worker);
      }
    }
    const rows = await sql<{
      rel: string;
      kind: 'table' | 'sequence';
      shared: boolean;
      missing: boolean;
      covered_by: string[];
    }>`
      WITH rels AS MATERIALIZED (
        SELECT c.oid, c.relname, c.relacl,
               NOT (lower(c.relname) = ANY(${engine}::text[]))
                 AND left(lower(c.relname), ${prefix.length}::int) = ${prefix}::text
                 AND NOT EXISTS (SELECT 1 FROM unnest(${longer}::text[]) p
                                  WHERE left(lower(c.relname), length(p)) = p) AS by_prefix,
               lower(c.relname) = ANY(${allowed}::text[]) AS listed,
               left(c.relname, 4) = 'zvd_'
                 AND NOT (lower(c.relname) = ANY(${engine}::text[])) AS data
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND NOT (c.relname = ANY(${NEVER_GRANTED}::text[]))
      ),
      picked AS (
        -- Inline, every non-engine zvd_* table goes to the shared role: the
        -- analyzer admits all of them to every extension as user data.
        SELECT oid, relname, relacl, by_prefix, ${inline}::boolean AND data AS shared
          FROM rels
         WHERE by_prefix OR (listed AND (${inline}::boolean OR data))
            OR (${inline}::boolean AND data)
      ),
      out AS (
        SELECT relname AS rel, 'table' AS kind, shared, by_prefix, relacl AS acl, 'SELECT' AS priv
          FROM picked
        UNION ALL
        SELECT s.relname, 'sequence', p.shared, p.by_prefix, s.relacl, 'USAGE'
          FROM picked p
          JOIN pg_depend d ON d.refobjid = p.oid AND d.classid = 'pg_class'::regclass
                          AND d.deptype IN ('a', 'i')
          JOIN pg_class s ON s.oid = d.objid
         WHERE s.relkind = 'S'
      )
      -- Held DIRECTLY, read off the ACL: has_table_privilege would count what an
      -- extension role inherits from the shared one.
      SELECT rel, kind, shared,
             NOT EXISTS (
               SELECT 1 FROM aclexplode(acl) a JOIN pg_roles r ON r.oid = a.grantee
                WHERE r.rolname = CASE WHEN shared THEN ${shared}::text ELSE ${own ?? shared}::text END
                  AND a.privilege_type = priv) AS missing,
             CASE WHEN by_prefix THEN ARRAY(
               SELECT DISTINCT r.rolname::text FROM aclexplode(acl) a
                 JOIN pg_roles r ON r.oid = a.grantee
                WHERE r.rolname = ANY(${covering}::text[]))
             ELSE ARRAY[]::text[] END AS covered_by
        FROM out
    `.execute(db);
    for (const r of rows.rows) {
      if (!r.shared && !own) continue;
      const on = r.kind === 'table' ? sql`TABLE` : sql`SEQUENCE`;
      const rel = sql.table(`public.${r.rel}`);
      if (r.missing) {
        const privs = r.kind === 'table' ? 'SELECT, INSERT, UPDATE, DELETE' : 'USAGE, SELECT';
        const to = r.shared ? shared : own!;
        await retryConcurrentUpdate(() =>
          sql`GRANT ${sql.raw(privs)} ON ${on} ${rel} TO ${sql.id(to)}`.execute(db),
        );
      }
      for (const from of r.covered_by) {
        await retryConcurrentUpdate(() =>
          sql`REVOKE ALL ON ${on} ${rel} FROM ${sql.id(from)}`.execute(db),
        );
      }
    }
    return rows.rows.map((r) => r.rel);
  } catch (err) {
    console.warn(
      `[extensions] "${extName}": granting its tables to ${own ?? shared} failed (continuing):`,
      (err as Error).message,
    );
    return [];
  }
}

/**
 * A GRANT or REVOKE racing another replica's on the same relation (first boot,
 * replicas loading the same extension) loses with XX000 "tuple concurrently
 * updated" — both rewrite the relation's ACL row. It used to end the whole
 * grant loop, so the extension's remaining tables went ungranted on the loser
 * and its own queries failed until the next restart. Retried, as role creation
 * is, 3 tries: the retry sees the winner's row and writes after it. Runs on the
 * pool (load and boot), never inside a transaction a failure would abort.
 */
async function retryConcurrentUpdate(run: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= 3 || (err as { errno?: unknown }).errno !== 'XX000') throw err;
    }
  }
}

/** The part of Kysely's QueryExecutor this file drives. */
interface RoleExecutor {
  executeQuery(query: CompiledQuery): Promise<{ rows: unknown[] }>;
}

/**
 * The statement that opens a role window: reads the role in effect and sets the
 * extension's, in one round trip (target-list order).
 *
 * `extName`: the CALLING extension, whose own role this is (`zveltio_ext` when it
 * has none). `mirror`: pick the twin with the same RLS reach as the role in
 * effect — the BYPASSRLS twin for a superuser or BYPASSRLS role, the plain role
 * for one RLS binds — so the switch never changes which tenants the statement
 * sees. The request's own tenant transaction always takes the plain role
 * (`mirror` false): there the tenant GUC is what the statement is meant to see.
 */
function setRoleSql(extName: string, mirror: boolean): string {
  const { plain, bypass } = windowRoles(extName);
  const role = mirror
    ? `CASE WHEN (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
            THEN ${bypass ? `'${bypass}'` : `current_setting('role')`}
            ELSE '${plain}' END`
    : `'${plain}'`;
  return `SELECT current_setting('role') AS prev, set_config('role', ${role}, true) AS now`;
}

/**
 * Close a role window on a database where boot could not take TEMPORARY from the
 * restricted roles (lib/tenancy/temp-privilege.ts): a temp table the statement
 * made would sit first on the search path of every later engine statement on
 * this transaction and, without ON COMMIT DROP, on this pooled connection.
 *
 * Inside the transaction, right after the statement: before the engine's next
 * statement can resolve a name, and a statement that failed created nothing a
 * rollback does not undo. It drops the session's ENGINE temp tables too — the
 * engine creates them only in migration 001, never around an extension
 * statement. Nothing at all where TEMPORARY is restricted.
 */
async function discardExtensionTemp(executor: RoleExecutor): Promise<void> {
  if (!temporaryObjectsRestricted()) await executor.executeQuery(CompiledQuery.raw('DISCARD TEMP'));
}

/**
 * The roles a window sets for this extension. Without a role of its own it gets
 * the shared pair, which with per-extension roles holds none of its tables.
 */
function windowRoles(extName: string): { plain: string; bypass: string | null } {
  const own = extRoles.get(extName);
  return {
    plain: own?.role ?? EXT_DB_ROLE,
    bypass: own?.bypass ?? (_bypassReady ? EXT_BYPASS_DB_ROLE : null),
  };
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
 *
 * `mirror`: see `setRoleSql` — true for a transaction other than the request's
 * own, e.g. `ctx.adminDb.transaction()`.
 */
export function asExtensionDbRole<T>(
  extName: string,
  trx: object,
  executor: RoleExecutor,
  run: () => Promise<T>,
  mirror = false,
): Promise<T> {
  // No usable role: the statement runs as the request's own role, no window —
  // and a temp table it makes shadows the engine's tables all the same.
  if (!_ready)
    return run().then(async (out) => {
      await discardExtensionTemp(executor);
      return out;
    });
  const mine = (windows.get(trx) ?? Promise.resolve()).then(() =>
    roleWindow(executor, run, setRoleSql(extName, mirror)),
  );
  windows.set(
    trx,
    mine.catch(() => undefined),
  );
  return mine;
}

async function roleWindow<T>(
  executor: RoleExecutor,
  run: () => Promise<T>,
  setRole: string,
): Promise<T> {
  const set = await executor.executeQuery(CompiledQuery.raw(setRole));
  const prev = String((set.rows[0] as { prev?: string } | undefined)?.prev ?? 'none');
  const restore = () =>
    executor.executeQuery(CompiledQuery.raw(`SELECT set_config('role', $1, true)`, [prev]));
  let out: T;
  try {
    out = await run();
    await discardExtensionTemp(executor);
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

/**
 * Run one extension statement that would have gone to the pool in a
 * transaction of its own that sets the role first: BEGIN, set, statement,
 * COMMIT. `run` gets the connection to send it on, or null where the pool keeps
 * the engine role (no usable role, or a bypassing engine with no twin).
 *
 * No restore: the COMMIT ends `set_config(…, true)`, so a statement that resets
 * the role resets it for itself only. A single statement commits exactly as it
 * did in autocommit; the price is a reserved connection and three more round
 * trips. Measured on a local Postgres 18, a primary-key SELECT through
 * `ctx.adminDb`: 125 → 504 µs sequential, 74 → 209 µs eight-way concurrent.
 */
export function asExtensionDbRoleOnPool<T>(
  extName: string,
  db: Database,
  run: (on: ConnectionProvider | null) => Promise<T>,
): Promise<T> {
  if (!_ready || (_loginBypasses && !windowRoles(extName).bypass)) return run(null);
  return db.transaction().execute(async (trx) => {
    const on = trx.getExecutor();
    await on.executeQuery(CompiledQuery.raw(setRoleSql(extName, true)));
    const out = await run(on);
    await discardExtensionTemp(on);
    return out;
  });
}

/**
 * Disable (and, with `drop`, uninstall): the extension's roles give up every
 * privilege they hold in this database and their membership in the shared role,
 * so they hold nothing; `drop` then removes them. The engine also stops setting
 * them here, so code of the extension still running — a timer its cleanup()
 * missed — gets the shared role, which holds none of its tables.
 *
 * Another replica that has not unloaded the extension yet keeps setting the role
 * and meets `permission denied` (or, after a drop, "role does not exist"): the
 * disable takes effect there too, by failing. Without per-extension roles there
 * is nothing to revoke — the shared role serves every other extension.
 */
export async function revokeExtensionDbRoles(
  db: Database,
  extName: string,
  drop = false,
): Promise<void> {
  extRoles.delete(extName);
  workerRoles.delete(extName);
  try {
    const n = extensionDbRoleNames(await currentDbName(db), extName);
    for (const [role, parent] of [
      [n.bypass, n.role],
      [n.role, EXT_DB_ROLE],
      [n.worker, WORKER_DB_ROLE],
    ] as const) {
      const held = await sql<{ rel: string; seq: boolean }>`
        SELECT c.relname AS rel, c.relkind = 'S' AS seq
          FROM pg_roles r
          JOIN pg_class c ON EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = r.oid)
          JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
         WHERE r.rolname = ${role}
      `.execute(db);
      for (const { rel, seq } of held.rows) {
        await sql`REVOKE ALL ON ${seq ? sql`SEQUENCE` : sql`TABLE`} ${sql.table(`public.${rel}`)} FROM ${sql.id(role)}`.execute(
          db,
        );
      }
      const member = await sql<{ m: boolean }>`
        SELECT EXISTS (SELECT 1 FROM pg_auth_members am
                         JOIN pg_roles r ON r.oid = am.member AND r.rolname = ${role}
                         JOIN pg_roles p ON p.oid = am.roleid AND p.rolname = ${parent}) AS m
      `.execute(db);
      if (member.rows[0]?.m) await sql`REVOKE ${sql.id(parent)} FROM ${sql.id(role)}`.execute(db);
      if (drop) await sql`DROP ROLE IF EXISTS ${sql.id(role)}`.execute(db);
    }
  } catch (err) {
    console.warn(
      `[extensions] "${extName}": revoking its database roles failed (continuing):`,
      (err as Error).message,
    );
  }
}

/** Test seam: forget the role state so a test can set it up again. */
export function _resetExtensionDbRoleForTests(): void {
  _ready = false;
  _loginBypasses = false;
  _bypassReady = false;
  _perExtension = false;
  _dbName = null;
  _ensuring = null;
  _workerNarrowed = false;
  extRoles.clear();
  workerRoles.clear();
}
