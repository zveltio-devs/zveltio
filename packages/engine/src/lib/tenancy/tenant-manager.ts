// packages/engine/src/lib/tenant-manager.ts
// Manages tenant schema lifecycle and resolution

import { createHmac, timingSafeEqual } from 'node:crypto';
import { type RawBuilder, sql } from 'kysely';
import { indexName } from '../pg-identifier.js';
import type { Database } from '../../db/index.js';
import { getCache } from '../runtime/index.js';
import {
  currentAfterCommitQueue,
  runAfterCommitJob,
  runWithTenantTrx,
  setSingleTenantScope,
  settleAfterCommit,
} from './tenant-context.js';
import { isGodUser } from './permissions.js';

/**
 * Who the request is, for the row-rule policies to read.
 *
 * `bypass` is a DECISION the engine has already taken — an API key carrying
 * `rlsBypass`, or the `data:view_all` permission a god holds — not a role name
 * for the database to compare. A role-name check is exactly what sat dead
 * inside `getRlsFilters` for years without anyone noticing.
 */
export interface RlsIdentity {
  userId: string;
  email: string;
  /** The direct role, as `getRlsFilters` uses it for a `user_role` source. */
  role: string;
  /** Casbin roles plus the direct one — what a rule's `role` is matched against. */
  roles: string[];
  bypass: boolean;
}
import {
  activeMembership,
  encodeTenantSet,
  godScopeQuery,
  noScopeQuery,
  type ScopeRow,
  scopeFromRow,
  type TenantScope,
  tenantScopeQuery,
} from './tenant-scope.js';

export { activeMembership };

/** `userCol` holds a membership in force in `tenantId` (a row, not the default-tenant rule). */
function liveMembership(userCol: string, tenantId: string): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM zv_tenant_users tu
                               WHERE tu.tenant_id::text = ${tenantId}
                                 AND tu.user_id = ${sql.ref(userCol)}
                                 AND ${activeMembership('tu')})`;
}

/**
 * `userCol` is a member of `tenantId` now, where the membership middleware draws
 * the line: everyone in the default tenant, elsewhere a membership in force.
 */
export function memberOfTenant(userCol: string, tenantId: string): RawBuilder<boolean> {
  return tenantId === DEFAULT_TENANT_ID ? sql<boolean>`true` : liveMembership(userCol, tenantId);
}

/**
 * The Casbin `g` row aliased `g` (user `g.v0`) grants its role in `tenantId` to
 * someone who can act there. Every audience drawn from `g` rows uses this, so a
 * role names the same people at every door.
 *
 * - A row in the tenant's own domain counts, unless the user's membership here
 *   has lapsed (rows exist, none in force): that grant derives from the
 *   membership, and the membership middleware refuses a lapsed member. No
 *   membership row at all is not a lapse.
 * - A row at `*` holds in every domain, so it says nothing about which tenant
 *   the holder belongs to: it counts only for a member of this tenant (#788).
 *   Otherwise tenant A's audience reaches people who belong only to tenant B.
 */
export function grantHoldsIn(g: string, tenantId: string): RawBuilder<boolean> {
  const v0 = `${g}.v0`;
  const v2 = sql.ref(`${g}.v2`);
  const anyRow = sql`EXISTS (SELECT 1 FROM zv_tenant_users tu
                              WHERE tu.tenant_id::text = ${tenantId} AND tu.user_id = ${sql.ref(v0)})`;
  return sql<boolean>`((${v2} = ${tenantId} AND (${liveMembership(v0, tenantId)} OR NOT ${anyRow}))
                       OR (${v2} = '*' AND ${memberOfTenant(v0, tenantId)}))`;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  settings: Record<string, any>;
}

export interface Environment {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  /** Set only on environments from before migration 043. */
  schema_name: string | null;
  is_production: boolean;
  color: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  settings: Record<string, any>;
}

const TENANT_CACHE_TTL = 300; // 5 min

// The implicit default tenant every install has. Single-tenant deployments
// resolve to it on every request, so the `zveltio.current_tenant` GUC is always
// set and RLS is uniform (single-tenant = "all data belongs to the default
// tenant"). Created by migration 007. Fixed sentinel UUID so it's referenced
// identically by the migration, the collection-table column default, and the
// always-resolve fallback below.
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TENANT_SLUG = 'default';

/**
 * May an API key owned by `keyTenantId` act in the request's tenant? Root keys
 * act anywhere; a request with no tenant acts in root. One definition, because
 * the auth path and the rate limiter must agree on which keys are real.
 */
export function apiKeyActsIn(
  keyTenantId: string | null | undefined,
  requestTenantId: string | null,
): boolean {
  if (!keyTenantId || keyTenantId === DEFAULT_TENANT_ID) return true;
  return keyTenantId === (requestTenantId ?? DEFAULT_TENANT_ID);
}

const DEFAULT_TENANT: Tenant = {
  id: DEFAULT_TENANT_ID,
  slug: DEFAULT_TENANT_SLUG,
  name: 'Default',
  status: 'active',
  settings: {},
};

/**
 * The default tenant row (cached). Falls back to the in-memory sentinel if the
 * row isn't present yet (e.g. during the very first boot before migrations) so
 * resolution never returns null.
 */
export async function getDefaultTenant(): Promise<Tenant> {
  return (await getTenantBySlug(DEFAULT_TENANT_SLUG)) ?? DEFAULT_TENANT;
}

const SAFE_COLLECTION_TABLE = /^zvd_[a-z0-9_]+$/i;
/**
 * Any plain identifier — used by the extension reconciler.
 *
 * This required a `zv_`/`zvd_` prefix, which read as a namespace rule and was
 * really a silent skip list. Eleven `trace_*` tables in `compliance/traceability`
 * declare a `tenant_isolation_*` policy and carry `tenant_id`, and the
 * reconciler passed over every one of them because of their name — so the
 * host's guarantee that it puts every extension table on the host's predicate
 * was not true, and nothing said so. Found when migration 003 split the read
 * and write predicates and those eleven kept the old combined one, which is the
 * form that lets a parent unit write into a child's rows.
 *
 * The prefix was never what made this safe. The reconciler only ever visits
 * tables named by `pg_policies` — they exist by construction — and the name is
 * still checked for a plain identifier before it is interpolated into DDL,
 * which is the part that matters.
 */
const SAFE_TENANT_TABLE = /^[a-z_][a-z0-9_]*$/i;
/** Policy names come from pg_policies, but they are interpolated into DDL. */
const SAFE_POLICY_NAME = /^[a-z0-9_]+$/i;

/**
 * Apply tenant row isolation to a single collection data table. Idempotent.
 * Ensures the tenant_id column (+ GUC default + NOT NULL, backfilling existing
 * rows to the default tenant) then ENABLE + FORCE RLS with the tenant_isolation
 * policy. Validated against Postgres 18: a non-superuser owner only sees rows of
 * the GUC tenant, cannot forge another tenant's tenant_id (WITH CHECK), and sees
 * zero rows when no GUC is set.
 *
 * IMPORTANT: FORCE RLS is bypassed by SUPERUSER / BYPASSRLS roles. The engine's
 * DB role MUST be a plain non-superuser or isolation is silently ineffective —
 * `warnIfDbRoleBypassesRls` checks this at boot.
 */
/**
 * Which overload of the visible-set function this table's policy must name.
 *
 * `tenant_id` is uuid on all but three tables, where it is TEXT — and there is
 * no `text = uuid` operator, so a policy handed the wrong array does not
 * silently widen or narrow, it fails to be created at all. Read from the
 * catalogue rather than assumed, because the two tables that have it are owned
 * by an extension and could be joined by another tomorrow.
 *
 * Falls back to the uuid form when the column cannot be read: every caller here
 * has already established the table has a `tenant_id`, and uuid is what the
 * engine creates.
 */
async function visibleTenantsFn(db: Database, table: string): Promise<string> {
  try {
    const r = await sql<{ is_uuid: boolean }>`
      SELECT a.atttypid = 'uuid'::regtype AS is_uuid
        FROM pg_attribute a
       WHERE a.attrelid = ${`public.${table}`}::regclass
         AND a.attname = 'tenant_id'
         AND NOT a.attisdropped
    `.execute(db);
    return r.rows[0]?.is_uuid === false
      ? '(SELECT zveltio_visible_tenants_text())::text[]'
      : '(SELECT zveltio_visible_tenants())::uuid[]';
  } catch {
    return '(SELECT zveltio_visible_tenants())::uuid[]';
  }
}

/**
 * Why the set function is wrapped in `(SELECT …)` rather than called directly.
 *
 * `tenant_id = ANY (fn())` gives the planner nothing to estimate with: it cannot
 * see how many elements the array has or how often they occur, so it assumes a
 * small match, takes the index, and then reads the whole table when the match is
 * in fact everything. `(SELECT fn())` makes the array an InitPlan parameter,
 * evaluated once, and `scalararraysel` can then reach the column statistics.
 *
 * Measured, 500 000 rows, median of 5, as the product runs it:
 *
 *                                     selective 2 500      full 500 000
 *   = ANY (fn())                          7.9 ms             406 ms
 *   = ANY ((SELECT fn())::uuid[])         7.9 ms             143 ms
 *
 * Identical where the index does the work, 2.8x faster where it cannot. The
 * full column is the single-tenant self-hosted install, where the unit owns
 * every row — so it is the common case, not the corner one.
 *
 * The cast is load-bearing in a different way: `= ANY (SELECT …)` parses as the
 * SUBQUERY form of ANY, which expects a set of rows rather than an array, so
 * without it the policy either means something else or fails to create.
 */
export async function applyTenantRLS(db: Database, table: string): Promise<void> {
  if (!SAFE_COLLECTION_TABLE.test(table)) {
    throw new Error(`refusing to apply RLS to unsafe table name: ${table}`);
  }
  const def = sql.raw(`'${DEFAULT_TENANT_ID}'::uuid`);
  await sql`
    ALTER TABLE ${sql.id(table)} ADD COLUMN IF NOT EXISTS tenant_id UUID DEFAULT ${def}
  `.execute(db);
  await sql`
    UPDATE ${sql.id(table)} SET tenant_id = ${def} WHERE tenant_id IS NULL
  `.execute(db);
  // NULLIF(..., '') is load-bearing: current_setting(..., true) returns an EMPTY
  // STRING (not NULL) when the GUC is set-but-blank — e.g. a god/single-tenant
  // request that runs without a tenant context. COALESCE only catches NULL, so
  // without the NULLIF the default evaluates `''::uuid` → "invalid input syntax
  // for type uuid" and every insert into an RLS table 500s. NULLIF maps '' → NULL
  // so COALESCE falls back to the default tenant.
  await sql`
    ALTER TABLE ${sql.id(table)} ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, ${def})
  `.execute(db);
  await sql`
    ALTER TABLE ${sql.id(table)} ALTER COLUMN tenant_id SET NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS ${sql.id(indexName(table, 'tenant_id'))} ON ${sql.id(table)}(tenant_id)
  `.execute(db);
  // And the composite the paginated read actually needs.
  //
  // The single-column index above lets the policy predicate be satisfied; it
  // does nothing for `ORDER BY created_at DESC LIMIT n`, which is what every
  // list endpoint issues. Without `(tenant_id, created_at DESC)` the planner
  // walks the `created_at` index and discards other tenants' rows as it goes, at
  // a cost proportional to how many tenants share the table. Measured on 300 000
  // rows across 63 tenants: 6 408 rows discarded to return 25, and 1,94 ms
  // against 0,08 ms once this index exists and the read carries an explicit
  // `tenant_id =` (see `tenantScopeId` in db/dynamic.ts — the policy alone
  // cannot drive it, because `= ANY` over a runtime array is not an index cond).
  //
  // Guarded on the column: this runs for collection tables, which always have
  // `created_at`, but the guard costs nothing and the next caller may not.
  const hasCreatedAt = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name = 'created_at'
  `.execute(db);
  if (hasCreatedAt.rows[0]?.n ?? 0) {
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.id(indexName(table, 'tenant_created'))}
      ON ${sql.id(table)}(tenant_id, created_at DESC)
    `.execute(db);
  }
  await sql`ALTER TABLE ${sql.id(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE ${sql.id(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.id(table)}`.execute(db);
  // The predicate lives in the two named functions rather than being spelled
  // out here. It used to be written inline, and the extension migration
  // template wrote its own fail-OPEN version of the same rule — two spellings
  // that behaved oppositely when a query arrived with no tenant context. Naming
  // it once is what makes that impossible to repeat.
  //
  // Two now, not one, and they are not interchangeable (migration 003).
  // `zveltio_tenant_scope_ok` answers WHICH UNITS may be read — the own node
  // today, a whole subtree for a consolidating parent. `zveltio_tenant_write_ok`
  // answers where a row may LAND, and the answer is always the own node: the
  // data belong to the subordinate, and a level above reads and approves rather
  // than correcting in someone else's place. Putting the read predicate back
  // into WITH CHECK would let a parent write into a child's rows.
  const visibleFn = await visibleTenantsFn(db, table);
  await sql`
    CREATE POLICY tenant_isolation ON ${sql.id(table)}
    USING (tenant_id = ANY (${sql.raw(visibleFn)}))
    WITH CHECK (zveltio_tenant_write_ok(tenant_id))
  `.execute(db);

  // The two narrow roles hold an allowlist of collection tables, and this is
  // where a collection joins it: `zveltio_worker` (the worker SQL bridge, DML)
  // and `zveltio_flow_reader` (flow `query_db` steps, SELECT) — the grants
  // migration 001 gave the tables that existed when it ran. `zveltio_worker`'s
  // create-time grant was never written, so every collection created after
  // install answered `permission denied` to every worker-isolated extension;
  // the flow reader's was made at CREATE TABLE, before any policy existed.
  //
  // Granted here, after FORCE and the policy, so neither role reaches a
  // collection before tenant isolation is on it. Every creator comes through
  // here — the create_collection job, an extension's `ctx.DDLManager` (on the
  // pool, committed before it returns) and the boot reconcile.
  // Probed rather than attempted: a role is absent where 001 could not create
  // it, and a refused GRANT would abort a caller's transaction.
  for (const role of await narrowRolesPresent(db)) {
    await sql`GRANT ${sql.raw(NARROW_ROLE_GRANTS[role])} ON ${sql.id(table)} TO ${sql.id(role)}`.execute(
      db,
    );
  }
}

/** The roles that may hold collection tables only, and what each holds on one. */
const NARROW_ROLE_GRANTS: Record<string, string> = {
  zveltio_worker: 'SELECT, INSERT, UPDATE, DELETE',
  zveltio_flow_reader: 'SELECT',
  // Inline extensions' `ctx.db` (lib/extensions/ext-db-role.ts): each
  // extension's own role inherits it. Not collection-only — it holds the
  // extensions' `zvd_*` tables, and on the shared layout their other tables too
  // — so the revoke below passes over it.
  zveltio_ext: 'SELECT, INSERT, UPDATE, DELETE',
};

async function narrowRolesPresent(db: Database): Promise<string[]> {
  const r = await sql<{ rolname: string }>`
    SELECT rolname FROM pg_roles WHERE rolname = ANY(${Object.keys(NARROW_ROLE_GRANTS)}::text[])
  `.execute(db);
  return r.rows.map((x) => x.rolname);
}

/**
 * The tables loaded worker extensions own, granted to `zveltio_worker` after their
 * migrations (lib/extensions/ext-db-role.ts). Extensions load before the boot
 * reconcile, whose revoke below took their `zvd_*` tables straight back.
 */
const workerExtensionTables = new Set<string>();

export function keepWorkerExtensionTables(tables: Iterable<string>): void {
  for (const t of tables) workerExtensionTables.add(t);
}

/**
 * Take the narrow roles off every `zvd_*` table that is not a collection.
 *
 * Migration 001 granted every table matching `zvd_%`, and that prefix is not
 * only collections: `zvd_permissions` (the Casbin policy table),
 * `zvd_rls_policies`, `zvd_column_permissions`, `zvd_collections`,
 * `zvd_webhooks` (signing secrets), `zvd_push_tokens` and more share it, most
 * without RLS. So a worker extension — the class the platform does not trust —
 * could write itself a `god` grant, and a flow step could read every tenant's
 * webhook secrets. Revoked at every boot, as `ensureRlsEnforcementRole` does
 * for the credential tables, so an install that ran the old grant heals; on a
 * settled install the query finds nothing.
 */
async function revokeNarrowRolesFromNonCollections(db: Database, tables: string[]): Promise<void> {
  for (const role of await narrowRolesPresent(db)) {
    if (role === 'zveltio_ext') continue;
    const spare = role === 'zveltio_worker' ? [...tables, ...workerExtensionTables] : tables;
    const stray = await sql<{ t: string }>`
      SELECT c.relname AS t
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND left(c.relname, 4) = 'zvd_'
         AND NOT (c.relname = ANY(${spare}::text[]))
         AND EXISTS (
           SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = ${role}::regrole)
    `.execute(db);
    for (const { t } of stray.rows) {
      await sql`REVOKE ALL ON ${sql.id(t)} FROM ${sql.id(role)}`.execute(db);
    }
  }
}

/**
 * Boot reconciler: put every extension-owned tenant table on the host's
 * predicate.
 *
 * Extensions install their own isolation from a copied `002_tenant_rls.sql`,
 * and all 54 copies were fail-open: no tenant context meant every tenant's
 * rows, where the engine's own tables meant none. Rewriting them here rather
 * than patching 54 files makes tenant isolation something the host guarantees
 * instead of something each extension author gets right — including extensions
 * that are not in this repository and cannot be edited from it.
 *
 * Targets exactly the tables that already declared a `tenant_isolation_*`
 * policy, so this adopts an extension's stated intent and never invents
 * isolation for a table that deliberately has none (catalogues, lookup data).
 *
 * Best-effort per table: one failure must not stop the engine from booting.
 *
 * `only` narrows it to the tables an extension's migrations just touched — the
 * runtime path (`runExtensionMigrations`), which must not lock every other
 * extension's tables to fix one install.
 */
export async function reconcileExtensionTenantRLS(
  db: Database,
  only?: readonly string[],
): Promise<number> {
  let targets: { tablename: string; policyname: string }[];
  try {
    const rows = await sql<{ tablename: string; policyname: string }>`
      SELECT tablename, policyname
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname LIKE 'tenant\\_isolation\\_%'
    `.execute(db);
    targets = only ? rows.rows.filter((r) => only.includes(r.tablename)) : rows.rows;
  } catch {
    return 0;
  }

  // Before #718 the build below compared names only, so every policed table
  // that already had its own `(tenant_id)` index got an identical
  // `idx_<t>_tenant_id` beside it — 289 of 329 on a full first-party install — and
  // every write paid for both. Dropped only where another valid, non-partial
  // index of the same kind has exactly that key, so a sole tenant index is never
  // touched. Here and not in a migration: which tables is only known at run
  // time, and CONCURRENTLY cannot run from a DO block. After the first boot this
  // finds nothing.
  try {
    const dups = await sql<{ index: string }>`
      SELECT i.relname AS index
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
       WHERE t.relname = ANY (${targets.map((r) => r.tablename)})
         AND i.relname = left('idx_' || t.relname || '_tenant_id', 63)
         AND a.attname = 'tenant_id'
         AND x.indnatts = 1 AND x.indexprs IS NULL AND x.indpred IS NULL
         AND EXISTS (
           SELECT 1 FROM pg_index y JOIN pg_class yi ON yi.oid = y.indexrelid
            WHERE y.indrelid = x.indrelid AND y.indexrelid <> x.indexrelid
              AND y.indisvalid AND y.indpred IS NULL AND y.indexprs IS NULL
              AND y.indnkeyatts = 1 AND y.indkey[0] = x.indkey[0]
              AND y.indclass[0] = x.indclass[0] AND yi.relam = i.relam)
    `.execute(db);
    for (const { index } of dups.rows) {
      await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id('public', index)}`
        .execute(db)
        .catch((err: Error) => console.warn(`[tenant-rls] could not drop ${index}:`, err.message));
    }
  } catch (err) {
    console.warn('[tenant-rls] duplicate tenant index sweep failed:', (err as Error).message);
  }

  let applied = 0;
  for (const { tablename, policyname } of targets) {
    // Extension tables are `zv_*` (their own namespace) or `zvd_*` (collection
    // data) — SAFE_COLLECTION_TABLE only matches the latter, so it would have
    // skipped every extension table this function exists to fix.
    if (!SAFE_TENANT_TABLE.test(tablename) || !SAFE_POLICY_NAME.test(policyname)) continue;
    const def = sql.raw(`'${DEFAULT_TENANT_ID}'::uuid`);
    try {
      // Backfill before switching the predicate. The old policy made a NULL
      // tenant_id visible to everyone; the new one makes it visible to nobody.
      // Without this the fix would read as data loss — the rows are simply
      // pre-tenant rows, and they belong to the default tenant, which is what
      // migration 007 already decided for the engine's own tables.
      const orphans = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n FROM ${sql.id(tablename)} WHERE tenant_id IS NULL
      `.execute(db);
      const n = orphans.rows[0]?.n ?? 0;
      if (n > 0) {
        await sql`
          UPDATE ${sql.id(tablename)} SET tenant_id = ${def} WHERE tenant_id IS NULL
        `.execute(db);
        console.warn(
          `[tenant-rls] ${tablename}: backfilled ${n} row(s) with no tenant_id to the ` +
            `default tenant — they were previously visible to every tenant.`,
        );
      }
      // Match the engine's column DEFAULT so writes and reads agree.
      await sql`
        ALTER TABLE ${sql.id(tablename)} ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, ${def})
      `.execute(db);
      // The index `applyTenantRLS` creates for collection tables, which this
      // path never did. A policy without it is not wrong, only slow: the
      // predicate can only become an Index Cond if there is an index to use,
      // and without one every tenant-scoped read of the table is a full scan.
      // Extensions that ship their own index are unaffected — 6 of 201
      // policy-bearing tables in a real install had none.
      //
      // Decided by shape, not by name: `IF NOT EXISTS` only compares names, so
      // a table that already led an index with `tenant_id` under any other name
      // (every engine table 023-029 policed, `idx_<t>_tenant`) got a byte-for-
      // byte duplicate, built at boot with writes blocked, and paid for it on
      // every write after.
      const leading = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n
          FROM pg_index x
          JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
         WHERE x.indrelid = ${`public.${tablename}`}::regclass
           AND a.attname = 'tenant_id'
           AND x.indisvalid
           AND x.indpred IS NULL
      `.execute(db);
      if (!(leading.rows[0]?.n ?? 0)) {
        await sql`
          CREATE INDEX IF NOT EXISTS ${sql.id(indexName(tablename, 'tenant_id'))}
          ON ${sql.id(tablename)}(tenant_id)
        `.execute(db);
      }
      // And the composite, for the same reason `applyTenantRLS` creates one:
      // the single-column index above satisfies the policy predicate and does
      // nothing for `ORDER BY created_at DESC LIMIT n`, which is what a listing
      // issues. Measured on 300 000 rows with the policy applied: a field filter
      // with ORDER BY costs 46 ms and discards every row in the table to return
      // 25 — at ten tenants and at a hundred alike, because the planner walks
      // the `created_at` index to satisfy the ordering and throws away whatever
      // the policy excludes.
      //
      // Guarded on the column, and this path needs the guard where the
      // collection path does not: an extension table is any shape its author
      // chose, and plenty have no `created_at`.
      const hasCreatedAt = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${tablename}
          AND column_name = 'created_at'
      `.execute(db);
      if (hasCreatedAt.rows[0]?.n ?? 0) {
        await sql`
          CREATE INDEX IF NOT EXISTS ${sql.id(indexName(tablename, 'tenant_created'))}
          ON ${sql.id(tablename)}(tenant_id, created_at DESC)
        `.execute(db);
      }
      await sql`ALTER TABLE ${sql.id(tablename)} ENABLE ROW LEVEL SECURITY`.execute(db);
      await sql`ALTER TABLE ${sql.id(tablename)} FORCE ROW LEVEL SECURITY`.execute(db);
      await sql`DROP POLICY IF EXISTS ${sql.id(policyname)} ON ${sql.id(tablename)}`.execute(db);
      const visibleFn = await visibleTenantsFn(db, tablename);
      await sql`
        CREATE POLICY ${sql.id(policyname)} ON ${sql.id(tablename)}
        USING (tenant_id = ANY (${sql.raw(visibleFn)}))
        WITH CHECK (zveltio_tenant_write_ok(tenant_id))
      `.execute(db);
      applied++;
    } catch (err) {
      console.warn(
        `[tenant-rls] extension reconcile failed for ${tablename}:`,
        (err as Error).message,
      );
    }
  }
  return applied;
}

/**
 * Boot reconciler: apply tenant isolation to every COLLECTION DATA table.
 * Targets `zvd_<name>` for each row in `zvd_collections` plus the built-in
 * content tables. The `zvd_collections`/`zvd_relations`/`zvd_permissions`
 * metadata tables are global and intentionally excluded (they are not rows in
 * zvd_collections). Best-effort per table — one failure doesn't abort the rest.
 */
export async function reconcileTenantRLS(db: Database): Promise<number> {
  let names: string[];
  try {
    const rows = await sql<{ name: string }>`SELECT name FROM zvd_collections`.execute(db);
    names = rows.rows.map((r) => r.name);
  } catch {
    return 0; // zvd_collections not present yet — nothing to reconcile
  }
  for (const builtin of ['pages', 'views', 'zones']) {
    if (!names.includes(builtin)) names.push(builtin);
  }

  // m2m junction tables hold tenant rows too and have no `zvd_collections` row
  // (migration 042). Found by the name `dropJunctionTable` enforces, so every
  // road that creates one is covered. A failed lookup leaves them out of the
  // narrow roles' set below — the side to fail on.
  const tables = new Set(names.map((n) => `zvd_${n}`));
  try {
    const j = await sql<{ t: string }>`
      SELECT tablename AS t FROM pg_tables
       WHERE schemaname = 'public' AND tablename LIKE 'zvd\\_jnc\\_%'
    `.execute(db);
    for (const { t } of j.rows) tables.add(t);
  } catch (err) {
    console.warn('[tenant-rls] junction table lookup failed:', (err as Error).message);
  }

  let applied = 0;
  for (const table of tables) {
    if (!SAFE_COLLECTION_TABLE.test(table)) continue;
    try {
      const reg = await sql<{ exists: boolean }>`
        SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
      `.execute(db);
      if (!reg.rows[0]?.exists) continue; // collection row without a table yet
      await applyTenantRLS(db, table);
      applied++;
    } catch (err) {
      console.warn(`[tenant-rls] reconcile failed for ${table}:`, (err as Error).message);
    }
  }
  try {
    await revokeNarrowRolesFromNonCollections(db, [...tables]);
  } catch (err) {
    console.warn('[tenant-rls] narrow-role revoke failed:', (err as Error).message);
  }
  return applied;
}

export type RlsMode = 'enforced' | 'native' | 'unavailable';

/**
 * Decide whether an RLS mode is fatal at boot. Pure on purpose.
 *
 * The decision used to live inline in `bootstrap()`, where nothing could reach
 * it: the only way to exercise "does production refuse to start without tenant
 * isolation" was to start a production engine against a broken database. That
 * is the shape every regression in this area has had — a documented mechanism
 * with nothing asserting it — so the rule is a function and the caller only
 * obeys it.
 *
 * Returns the reason to refuse, or null to proceed.
 */
export function rlsBootFailure(opts: {
  mode: RlsMode;
  nodeEnv: string | undefined;
  override: boolean;
}): string | null {
  if (opts.mode !== 'unavailable') return null;
  if (opts.nodeEnv !== 'production') return null;
  if (opts.override) return null;
  return (
    'Tenant isolation cannot be enforced: the zveltio_rls role is unavailable and this ' +
    'connection bypasses row-level security.'
  );
}

/**
 * Warn if the engine's DB role can bypass RLS (SUPERUSER or BYPASSRLS).
 * FORCE RLS does NOT bind such roles. Called once at boot.
 *
 * Takes the mode from `initRlsEnforcementRole` because the same fact means two
 * different things depending on it, and the message used to state only the
 * worse one. Under `enforced`, `withTenantIsolation` drops to `zveltio_rls`
 * before it touches a tenant row, so isolation IS applied on that path and the
 * residual exposure is queries that never enter it — the raw pool, background
 * jobs, migrations. Under `unavailable` there is nothing to drop to and the
 * exposure is total; `index.ts` refuses to boot on that in production.
 *
 * Saying "tenant isolation is NOT enforced" in both cases printed a direct
 * contradiction of the line above it whenever the role mechanism was working,
 * and a contradiction at boot is read as noise by the operator it was meant to
 * alert.
 */
export async function warnIfDbRoleBypassesRls(
  db: Database,
  mode: 'enforced' | 'native' | 'unavailable' = 'unavailable',
): Promise<void> {
  // `native` means the role is already plain, so there is nothing to report
  // even if this somehow gets called with it.
  if (mode === 'native') return;
  try {
    const r = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `.execute(db);
    const row = r.rows[0];
    if (!row?.rolsuper && !row?.rolbypassrls) return;

    const trait = row.rolsuper ? 'a SUPERUSER' : 'BYPASSRLS';
    if (mode === 'enforced') {
      console.warn(
        `⚠️  [tenant-rls] The engine DB role "${row.rolname}" is ${trait}, so it is not bound by ` +
          'row-level security on its own. Tenant requests are still isolated — they run as ' +
          'zveltio_rls — but any query outside withTenantIsolation() (raw pool, background jobs, ' +
          'migrations) sees every tenant. Run the engine as a plain (NOSUPERUSER, no BYPASSRLS) ' +
          'role to close that gap.',
      );
      return;
    }
    console.warn(
      `⚠️  [tenant-rls] The engine DB role "${row.rolname}" is ${trait} — Postgres row-level ` +
        'security is BYPASSED, so tenant isolation is NOT enforced. Run the engine as a plain ' +
        '(NOSUPERUSER, no BYPASSRLS) role for multi-tenant deployments.',
    );
  } catch {
    /* non-fatal */
  }
}

// ── Tenant cache HMAC signing ────────────────────────────────────────────────
// Protects cached tenant data against tampering by an attacker with Valkey
// write access (e.g. activating a banned tenant). Pattern mirrors the god-role cache in permissions.ts.
function _tenantHmac(key: string, value: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set — tenant cache HMAC would use an empty key, providing no integrity protection. Set this environment variable before starting the server.',
    );
  }
  return createHmac('sha256', secret).update(`tenant:${key}:${value}`).digest('hex');
}

function _encodeTenantCache(key: string, data: object): string {
  const json = JSON.stringify(data);
  return `${_tenantHmac(key, json)}:${json}`;
}

function _decodeTenantCache(key: string, raw: string): object | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const storedHmac = raw.slice(0, sep);
  const json = raw.slice(sep + 1);
  try {
    const expected = Buffer.from(_tenantHmac(key, json), 'hex');
    const stored = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}
// ── End HMAC helpers ─────────────────────────────────────────────────────────

let _db: Database;

export function initTenantManager(db: Database): void {
  _db = db;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const cache = getCache();
  const cacheKey = `tenant:slug:${slug}`;

  if (cache) {
    const raw = await cache.get(cacheKey).catch(() => null);
    if (raw) {
      const decoded = _decodeTenantCache(cacheKey, raw);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      if (decoded) return decoded as any;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const tenant = await (_db as any)
    .selectFrom('zv_tenants')
    .selectAll()
    .where('slug', '=', slug)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (tenant && cache) {
    await cache
      .setex(cacheKey, TENANT_CACHE_TTL, _encodeTenantCache(cacheKey, tenant))
      .catch(() => {});
  }

  return tenant || null;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const cache = getCache();
  const cacheKey = `tenant:id:${id}`;

  if (cache) {
    const raw = await cache.get(cacheKey).catch(() => null);
    if (raw) {
      const decoded = _decodeTenantCache(cacheKey, raw);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      if (decoded) return decoded as any;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const tenant = await (_db as any)
    .selectFrom('zv_tenants')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (tenant && cache) {
    await cache
      .setex(cacheKey, TENANT_CACHE_TTL, _encodeTenantCache(cacheKey, tenant))
      .catch(() => {});
  }

  return tenant || null;
}

/** What `stillInTenant` reads off a realtime connection. */
interface TenantBoundConnection {
  tenantId: string | null;
  /** A session's carries `userId`; an API key's does not. */
  principal: { kind: string; userId?: string } | null;
}

/**
 * The realtime sweep's tenant rule: may a connection opened in `tenantId` stay
 * open? The tenant middleware refuses every request to a tenant that is not
 * 'active' (archived, suspended, purged), and the membership middleware every
 * session whose user holds no membership in force there (`activeMembership`) —
 * but a socket or stream is admitted once, at open, so each sweep asks both
 * again, for all of them.
 *
 * Membership as the middleware asks it: the default tenant counts everyone, a
 * god is exempt, and an API key is not asked here: its creator's membership in
 * the key's tenant is part of the key lookup (`stillAuthenticated`). A lapse is a date with no event, so the periodic principal sweep
 * (`startPolicyReconcile`) is what reaches it. `null` (no tenant captured)
 * always holds.
 *
 * One query per question for every connection, from the tables: the cache copy
 * is what an archive has just dropped. Throws when a lookup fails — that is not
 * an archive or a lapse.
 */
export async function stillInTenant(
  db: Database,
  conns: Iterable<TenantBoundConnection>,
): Promise<(conn: TenantBoundConnection) => boolean> {
  const list = [...conns];
  const ids = [...new Set(list.flatMap((c) => (c.tenantId ? [c.tenantId] : [])))];
  const active = new Set<string>();
  if (ids.length > 0) {
    const rows = await db
      .selectFrom('zv_tenants')
      .select('id')
      .where('id', 'in', ids)
      .where('status', '=', 'active')
      .execute();
    for (const r of rows) active.add(r.id);
  }
  const memberOf = (c: TenantBoundConnection) =>
    c.principal?.kind === 'session' && c.tenantId && c.tenantId !== DEFAULT_TENANT_ID
      ? c.principal.userId
      : undefined;
  const asked = list.filter((c) => memberOf(c) && active.has(c.tenantId!));
  const held = new Set<string>();
  if (asked.length > 0) {
    const users = [...new Set(asked.map((c) => memberOf(c)!))];
    const tenants = [...new Set(asked.map((c) => c.tenantId!))];
    // `role = 'god'` is `isGodUser`'s own question, asked here so a failed read
    // throws instead of answering "not god" and closing a god's sockets.
    const rows = await sql<{ user_id: string; tenant_id: string }>`
      SELECT user_id, tenant_id::text AS tenant_id FROM zv_tenant_users
       WHERE user_id = ANY(${sql.val(users)}::text[])
         AND tenant_id = ANY(${sql.val(tenants)}::uuid[])
         AND ${activeMembership()}
      UNION ALL
      SELECT id, '*' FROM "user" WHERE id = ANY(${sql.val(users)}::text[]) AND role = 'god'
    `.execute(db);
    for (const r of rows.rows) held.add(`${r.tenant_id}:${r.user_id}`);
  }
  return (c) => {
    if (c.tenantId === null) return true;
    if (!active.has(c.tenantId)) return false;
    const userId = memberOf(c);
    return !userId || held.has(`${c.tenantId}:${userId}`) || held.has(`*:${userId}`);
  };
}

export async function getUserTenants(userId: string): Promise<(Tenant & { role: string })[]> {
  const cache = getCache();
  const cacheKey = `user:tenants:${userId}`;

  if (cache) {
    const raw = await cache.get(cacheKey).catch(() => null);
    if (raw) {
      const decoded = _decodeTenantCache(cacheKey, raw);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      if (decoded) return decoded as any;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const tenants = await (_db as any)
    .selectFrom('zv_tenant_users as tu')
    .innerJoin('zv_tenants as t', 't.id', 'tu.tenant_id')
    .selectAll('t')
    .select(['tu.role'])
    .where('tu.user_id', '=', userId)
    .where('t.status', '=', 'active')
    // A lapsed assignment is no unit to switch to. Cached for TENANT_CACHE_TTL,
    // so a `valid_to` passing shows here within that bound; the membership
    // middleware, which is what actually refuses, reads uncached.
    .where(activeMembership('tu'))
    .execute();

  if (cache) {
    await cache
      .setex(cacheKey, TENANT_CACHE_TTL, _encodeTenantCache(cacheKey, tenants))
      .catch(() => {});
  }

  return tenants;
}

export function getTenantSchemaName(tenantSlug: string): string {
  const safe = tenantSlug.replace(/[^a-z0-9_]/g, '_').toLowerCase();
  return `tenant_${safe}`;
}

/**
 * Register a named environment in zv_environments. It gets no Postgres schema:
 * nothing reads one (per-environment isolation is the preview `branch_*`
 * schemas), and `tenant_<a>_<x>` also spelled tenant `a-x`'s. Rows from before
 * migration 043 may still name one; purge drops it.
 */
export async function provisionEnvironment(
  tenantId: string,
  envSlug: string,
  envName: string,
  isProduction: boolean,
): Promise<void> {
  const colorMap: Record<string, string> = {
    prod: '#dc2626',
    production: '#dc2626',
    staging: '#d97706',
    dev: '#2563eb',
    development: '#2563eb',
  };

  // As the firm it belongs to: `zv_environments` is policed (migration 029), and
  // the pool writes nothing a policy's WITH CHECK would accept on a
  // non-superuser database.
  await withTenantIsolation(tenantId, (trx) =>
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    (trx as any)
      .insertInto('zv_environments')
      .values({
        tenant_id: tenantId,
        name: envName,
        slug: envSlug,
        is_production: isProduction,
        color: colorMap[envSlug] || '#6b7280',
      })
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .onConflict((oc: any) => oc.columns(['tenant_id', 'slug']).doNothing())
      .execute(),
  );
}

export async function getTenantEnvironments(tenantId: string): Promise<Environment[]> {
  // Inside the firm, not on the pool: policed since migration 029.
  return withTenantIsolation(tenantId, (trx) =>
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    (trx as any)
      .selectFrom('zv_environments')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('is_production', 'desc')
      .execute(),
  );
}

/**
 * The request's environment. `db` must be inside `tenant`'s isolation — the
 * request transaction, or a `withTenantIsolation` of the caller's: the table is
 * policed (migration 029), and on the pool of a non-superuser database every
 * firm but the default one would resolve to nothing.
 */
export async function resolveEnvironment(
  db: Database,
  tenant: Tenant,
  headers: Headers,
): Promise<Environment | null> {
  const envSlug = headers.get('x-environment') || 'prod';

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const env = await (db as any)
    .selectFrom('zv_environments')
    .selectAll()
    .where('tenant_id', '=', tenant.id)
    .where('slug', '=', envSlug)
    .executeTakeFirst();

  return env || null;
}

/**
 * Resolve tenant from HTTP request.
 * Priority:
 *   1. X-Tenant-Slug header
 *   2. Subdomain (tenant.yourdomain.com)
 *   3. ZVELTIO_TENANT_ID env var (legacy single-tenant fallback)
 */
export async function resolveTenantFromRequest(
  headers: Headers,
  hostname?: string,
): Promise<Tenant | null> {
  // Priority 1: explicit header
  const headerSlug = headers.get('x-tenant-slug');
  if (headerSlug) return getTenantBySlug(headerSlug);

  // Priority 2: subdomain. NEVER for IP hostnames: "127.0.0.1" splits into 4
  // dot-parts, so it used to be parsed as subdomain "127" → tenant lookup miss →
  // null → the middleware proceeded WITHOUT the tenant GUC and RLS rejected
  // every data write (42501 → 500) and hid every row. Any access by IP —
  // http://127.0.0.1:3000, a LAN address, a fresh demo box — hit this. IPs and
  // bracketed IPv6 have no subdomain semantics; fall through to the default
  // tenant (always-one-tenant) like "localhost" does.
  if (hostname) {
    const isIpV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    const isIpV6 = hostname.includes(':') || hostname.startsWith('[');
    if (!isIpV4 && !isIpV6) {
      const parts = hostname.split('.');
      if (parts.length >= 3) {
        const subdomain = parts[0];
        if (subdomain !== 'www' && subdomain !== 'api') {
          // Unknown subdomain slug → fall through to the default tenant rather
          // than returning null: null silently disables the tenant GUC, which
          // breaks RLS in the worst possible way (empty reads + 500 writes).
          const bySub = await getTenantBySlug(subdomain);
          if (bySub) return bySub;
        }
      }
    }
  }

  // Priority 3: env var (legacy single-tenant mode)
  const envTenantId = process.env.ZVELTIO_TENANT_ID;
  if (envTenantId) {
    return {
      id: envTenantId,
      slug: envTenantId,
      name: process.env.ZVELTIO_TENANT_NAME || 'Default',
      status: 'active',
      settings: {},
    };
  }

  // Always-one-tenant: no explicit tenant → the implicit default tenant, so the
  // `zveltio.current_tenant` GUC is always set on data routes and RLS is uniform.
  // Single-tenant installs run entirely as the default tenant.
  return getDefaultTenant();
}

export async function invalidateTenantCache(
  slug: string,
  id?: string,
  userId?: string,
): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  await cache.del(`tenant:slug:${slug}`).catch(() => {});
  if (id) await cache.del(`tenant:id:${id}`).catch(() => {});
  if (userId) await cache.del(`user:tenants:${userId}`).catch(() => {});
}

/**
 * Returns the initialized database instance (used by the tenant middleware to
 * start a per-request transaction for SET LOCAL isolation).
 */
export function getTenantDb(): Database {
  return _db;
}

/**
 * Wraps a callback in a PostgreSQL transaction with SET LOCAL for the tenant GUC.
 * This is the ONLY correct way to ensure RLS isolation in a connection-pool environment:
 * SET LOCAL is scoped to the transaction, so all queries made via `trx` within the
 * callback will see the correct tenant GUC, and the connection is automatically
 * released back to the pool after the transaction commits/rolls back.
 *
 * Usage in route handlers: use `c.get('tenantTrx') || db` for queries.
 */
export async function withTenantIsolation<T>(
  tenantId: string,
  fn: (trx: Database) => Promise<T>,
  opts?: { userId?: string | null; identity?: RlsIdentity },
): Promise<T> {
  // Work queued for after the COMMIT, captured inside the store and run outside
  // it. Four callers used `setTimeout(…, 0)` for this, and an audit showed the
  // timer fires with the transaction still open — so the write they were trying
  // to keep off the request's connection took a second one anyway.
  //
  // The queue is SETTLED here, after the transaction, not drained inside it: a
  // job queued after the handler returned — by a caller that does not await its
  // own promise — lands between the two, and used to be pushed onto a queue
  // already taken.
  let afterCommit: ReturnType<typeof currentAfterCommitQueue>;

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const run = (_db as any).transaction().execute(async (trx: Database) => {
    // Drop to a role Postgres will actually apply RLS to.
    //
    // `docker-compose.yml` passes POSTGRES_USER to the official Postgres image,
    // which creates it as a SUPERUSER — and FORCE ROW LEVEL SECURITY does not
    // bind superusers. So on a stock install every isolation policy in this
    // codebase was advisory, and the boot warning about it scrolled past in the
    // startup log. Rather than depending on how the operator configured their
    // database, the engine spends each tenant transaction as a plain role; the
    // role reverts when the transaction ends.
    //
    // Only DATA access is downgraded. Schema-management routes do not open this
    // transaction at all (TXN_SKIP_PREFIXES), so DDL keeps the owner's rights.
    //
    // Skipped when the role is absent — a managed Postgres may not have let
    // migration 030 create it, and the engine has to keep working there.
    // Resolve the reach BEFORE dropping the role, while still the engine's own.
    // `zveltio_tenant_subtree` reads `zv_tenants`, and making the visible set
    // depend on grants held by the restricted role is how a reach silently
    // narrows on an install where migration 030 never ran.
    //
    // Only when a user is named. Everything else — background workers, boot
    // reconcilers, API-key traffic, single-tenant installs — publishes no set
    // and is answered by the equality fallback inside the predicate, which is
    // exactly what it did before the hierarchy existed.
    let scopeQuery = noScopeQuery();
    if (opts?.userId && (await isGodUser(opts.userId).catch(() => false))) {
      // God's reach is EVERY firm, and it is published to the database rather
      // than taken by escaping it.
      //
      // Until now a god saw across firms only by running on `poolDb` — the pool
      // connects as a superuser with `rolbypassrls`, so the policies were not
      // consulted at all. The privilege was not expressed anywhere; it was a way
      // around the thing that expresses privileges. A handler that forgot its
      // check on that connection read every firm's rows and nothing downstream
      // could tell.
      //
      // Published here, `zveltio.visible_tenants` is the first branch of the
      // predicate every policy already evaluates, so god is enforced BY the
      // database on the same code path as everyone else, and the ordinary
      // request pays nothing: the GUC was always written, only its contents
      // differ.
      //
      // Measured before choosing this shape. Two other forms were tried and
      // rejected: teaching `zveltio_visible_tenants()` to expand to all firms
      // itself costs 0,061 ms → 0,434 ms on EVERY ordinary request, because the
      // subquery stops the function being inlined; adding `OR zveltio_is_god()`
      // to 300+ policies costs 6 microseconds but has to rewrite all of them.
      // This one costs nothing and touches no policy.
      scopeQuery = godScopeQuery();
    } else if (opts?.userId) {
      // A reach that cannot be resolved fails the statement, and with it the
      // transaction and the request — never "see everything". (The old
      // catch-and-fall-back could not work either: a failed statement aborts
      // the transaction, so the `set_config` after it failed with 25P02.)
      scopeQuery = tenantScopeQuery(opts.userId, tenantId);
    }

    // The caller's identity, published for the row-rule policies to read.
    //
    // Only what the caller HANDS US. Resolving an email, a role list and a
    // bypass permission here would be three lookups on the hot path, and the
    // caller that has them — the request middleware — already does. A caller
    // that publishes nothing (background jobs, boot reconcilers) leaves the
    // settings empty, and an empty setting makes a rule SKIP: the same
    // fail-open-for-that-rule the engine applies when it cannot resolve a value,
    // and the same outcome those callers have today, where `getRlsFilters` is
    // never asked at all.
    const identity = {
      userId: opts?.identity?.userId ?? '',
      email: opts?.identity?.email ?? '',
      role: opts?.identity?.role ?? '',
      roles: (opts?.identity?.roles ?? []).join(','),
      bypass: opts?.identity?.bypass ?? false,
    };

    // Whether there is an ACTOR at all — written as its own setting, because
    // absence cannot be detected.
    //
    // A row rule needs to tell two things apart: a request whose identity has a
    // field that is empty, and work that has no identity at all. Reading them
    // off one setting does not work, and that is measured rather than assumed:
    //
    //     after SET LOCAL + COMMIT  ->  ''    (the setting survives, emptied)
    //     on a connection never set ->  NULL
    //
    // So `current_setting(x, true) IS NULL` means "first request on a fresh
    // pooled connection", not "no identity" — a security predicate that would
    // depend on pool luck and pass every test run against a cold pool.
    // `set_config(x, NULL, true)` does not unset either; it also leaves ''.
    //
    // Hence a separate flag, ALWAYS written like the rest, saying what the empty
    // spellings cannot: background jobs and boot reconcilers publish no identity
    // and get `off`, and a rule stands down for them exactly as it does today.
    const hasActor = (opts?.identity?.userId ?? '') !== '';

    // set_config(..., is_local=true) is the transaction-local equivalent of
    // SET LOCAL but accepts a bind parameter — `SET LOCAL x = $1` is a Postgres
    // syntax error.
    //
    // All of them in ONE round trip, and all ALWAYS written, including the empty
    // spellings. A pooled connection is shared; leaving a GUC unset means
    // inheriting whatever the previous occupant left, and two of these decide
    // what a request can see.
    //
    // `role` rides along rather than being its own `SET LOCAL ROLE` statement.
    // `role` is a GUC like the others, so `set_config('role', …, true)` is the
    // same downgrade — verified, not assumed: it yields `current_user =
    // zveltio_rls` and the same single tenant visible, where the engine's own
    // superuser role sees all 63 in the same table. Measured, the merge takes the
    // per-request setup from 0,230 ms to 0,175 ms — a fifth of it, for one fewer
    // round trip. It is also faster than moving the role onto the pool's own
    // identity (0,181 ms), which would have been an architecture change.
    //
    // The reach rides along too: computed in SQL and published by the statement
    // that computes it, one round trip where there were up to five. The reach is
    // still read as the engine's own role, as when it was a separate statement:
    // it is a MATERIALIZED single-row CTE, so its reads finish before the
    // projection runs, and `role` is the LAST setting projected. (Postgres also
    // checks a statement's tables as the role it started with — measured with
    // SELECT on `zv_tenants` revoked from `zveltio_rls`; see
    // tenant-scope-round-trips.test.ts.)
    const applied = await sql<ScopeRow>`
      WITH reach AS MATERIALIZED (${scopeQuery})
      SELECT reach.visible_csv,
             reach.ancestors_csv,
             set_config('zveltio.current_tenant', ${tenantId}, true),
             set_config('zveltio.visible_tenants', coalesce(reach.visible_csv, ''), true),
             set_config('zveltio.ancestor_tenants', coalesce(reach.ancestors_csv, ''), true),
             set_config('zveltio.user_id', ${identity.userId}, true),
             set_config('zveltio.user_email', ${identity.email}, true),
             set_config('zveltio.user_role', ${identity.role}, true),
             set_config('zveltio.user_roles', ${identity.roles}, true),
             set_config('zveltio.actor', ${hasActor ? 'on' : 'off'}, true),
             set_config('zveltio.rls_bypass', ${identity.bypass ? 'on' : 'off'}, true),
             set_config('role', ${_rlsRoleAvailable ? 'zveltio_rls' : 'none'}, true)
        FROM reach
    `.execute(trx);
    const row = applied.rows[0];
    // No user named, no reach: the old `scope === null`, which the single-unit
    // decision below reads differently from a resolved `{ visible: null }`.
    const scope: TenantScope | null = opts?.userId && row ? scopeFromRow(row) : null;
    // Bind the transaction to the async context as well as handing it to `fn`.
    //
    // `ctx.db` given to extensions is a proxy that resolves
    // `getCurrentTenantTrx()` per query, which is what makes a plain `db` in an
    // extension route tenant-scoped without threading anything. Background work
    // opened its transaction here and did NOT set that store, so inside a job
    // `ctx.db` still fell through to the global pool — the one place the
    // guarantee quietly did not hold, and the reason `data/export` had to be
    // handed its transaction explicitly.
    //
    // Setting it here means there is ONE spelling that is correct everywhere:
    // in a handler, in a helper called from one, and in a job.
    return runWithTenantTrx(trx, tenantId, async () => {
      // Whether the reach is this tenant alone — decided HERE, beside the scope
      // that produced it, rather than re-derived later from a GUC string.
      setSingleTenantScope(isSingleUnitReach(scope, tenantId));
      // Captured while the store is alive; settled below, once the transaction is.
      afterCommit = currentAfterCommitQueue();
      return await fn(trx);
    });
  });

  let result: unknown;
  try {
    result = await run;
  } catch (err) {
    if (afterCommit) settleAfterCommit(afterCommit, false);
    throw err;
  }
  // One failed follow-up must not take the request's answer with it: the
  // transaction is already committed and the caller already has its result.
  for (const job of afterCommit ? settleAfterCommit(afterCommit, true) : []) {
    await runAfterCommitJob(job);
  }
  return result as T;
}

/**
 * A transaction on `db` that READS every firm's rows, for background work that
 * has to see across firms by design — the flow scheduler's claim, and the flow
 * executor's lookup of which firm a flow runs as.
 *
 * On a non-superuser database the pool with no GUC answers a policed table for
 * the default firm only, so a worker that just used the pool quietly did nothing
 * for every other firm. The reach is published the way god's is in
 * `withTenantIsolation` — every firm in `zveltio.visible_tenants`, as the plain
 * role — so the database still decides, on the same predicate as everyone else.
 *
 * WRITES are not widened: WITH CHECK is the own node, and none is set here. A
 * caller that writes a row sets `zveltio.current_tenant` to that row's firm in
 * the statement before it.
 */
export async function withEveryTenant<T>(
  db: Database,
  fn: (trx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // Before dropping the role, as `withTenantIsolation` reads god's reach.
    await publishEveryTenant(trx);
    await sql`SELECT set_config('role', ${_rlsRoleAvailable ? 'zveltio_rls' : 'none'}, true)`.execute(
      trx,
    );
    return fn(trx);
  });
}

/**
 * `withEveryTenant`'s read reach, on a transaction the caller already holds and
 * without leaving the caller's role — for work that must stay the table owner,
 * such as a Ghost DDL copy. Rows whose `tenant_id` names no `zv_tenants` row
 * stay invisible, exactly as they are to `withEveryTenant`.
 */
export async function publishEveryTenant(trx: Database): Promise<void> {
  const all = await sql<{ id: string }>`SELECT id::text AS id FROM zv_tenants`.execute(trx);
  await sql`
    SELECT set_config('zveltio.visible_tenants', ${encodeTenantSet(all.rows.map((r) => r.id))}, true)
  `.execute(trx);
}

/**
 * Is the request's READ reach this tenant and nothing else?
 *
 * The answer decides whether a handler may add an explicit `tenant_id = <id>`
 * beside the policy. That equality is what lets a read use `(tenant_id, …)` —
 * the policy alone cannot, because `= ANY` over an array the planner does not
 * see until execution is not an index condition. Measured on 300 000 rows: a
 * field filter with `ORDER BY` costs 46 ms and discards every row in the table
 * to return 25, at ten tenants and at a hundred.
 *
 * It used to be `scope === null`, and that was wrong in a way nothing caught.
 * `resolveTenantScope` NEVER returns null — it returns an object on every
 * branch, `{ visible: [tenantId] }` included, for the commonest case of all: a
 * user whose assignment is `read_scope='self'` on a tenant with no hierarchy.
 * And `userId` is passed for every request carrying a session. So the fast path
 * was live for API keys and background work, and dead for every logged-in user.
 * Measured with a probe before this was touched:
 *
 *     no userId  (API key / background):  equality on 0000…0001
 *     with userId (authenticated request): NULL — no equality
 *
 * What makes the reach single, and why each case is safe:
 *
 *   - no scope at all — no user was named, so nothing published a visible set;
 *     `zveltio_visible_tenants()` falls through to `[current_tenant]`.
 *   - `visible === null` — the same, deliberately: the resolver publishes nothing
 *     when there is no assignment (a god user, an API key, an install where
 *     nobody was enrolled) and lets the predicate answer with the equality it
 *     always used.
 *   - `visible` naming exactly this tenant — the reach IS this tenant.
 *
 * Anything wider is not single, and the equality must not be added: it would
 * hide rows the request is entitled to. Ancestors do not enter this decision —
 * `zveltio_visible_tenants()` reads only `zveltio.visible_tenants`, so an
 * ancestor is visible for reading only by being IN that set, where the length
 * check above already sees it.
 */
function isSingleUnitReach(scope: TenantScope | null, tenantId: string): boolean {
  if (scope === null) return true;
  if (scope.visible === null) return true;
  return scope.visible.length === 1 && scope.visible[0] === tenantId;
}

/**
 * Whether `SET LOCAL ROLE zveltio_rls` will work on this database.
 *
 * Resolved once at boot rather than probed per request: the answer cannot
 * change while the process runs, and a failed SET aborts the surrounding
 * transaction, so discovering it lazily would break the first request instead
 * of logging a line at startup.
 */
let _rlsRoleAvailable = false;

/**
 * Recreate `zveltio_rls` if it is not here, before deciding whether it is.
 *
 * Migration 030 creates the role, and a migration runs once. `zveltio_rls` is a
 * CLUSTER object, so `pg_dump` does not carry it — and the ledger of applied
 * migrations IS in the dump. Restore a backup onto new hardware and you get
 * every table, every policy, and a `zv_schema_versions` row saying 030 already ran,
 * on a server where the role has never existed and never will.
 *
 * What happens next is quiet rather than loud. The policies restore fine, since
 * they name a function and not a role. The `GRANT … TO zveltio_rls` statements
 * in the dump fail, the restore continues past them, and at boot the engine
 * finds no role, falls back to connecting as itself, and — if that connection
 * is a superuser, which it is on a default install — RLS does not apply to it.
 * There is a warning in the log. It is competing for attention with a disaster.
 *
 * So the role is provisioned here, at every boot, rather than once in a
 * migration. Idempotent and identical to what 030 does; on a healthy instance
 * it grants what is already granted and returns.
 *
 * Best-effort by design: a managed Postgres where the engine's user cannot
 * create roles is a legitimate deployment, and it should keep starting and keep
 * warning, exactly as it does now. Failing here would turn a degraded restore
 * into no restore at all.
 */
async function ensureRlsEnforcementRole(db: Database): Promise<void> {
  // Three steps, three statements, three independent failures — deliberately.
  //
  // This was one DO block, and Postgres aborts a DO block at the first error.
  // On a non-superuser install the second step (granting membership) fails,
  // which meant the third step never ran: `zveltio_rls` ended up with USAGE on
  // nothing and SELECT on 11 of 378 tables. The engine then reported "Tenant
  // RLS enforced", switched into the role for every tenant request, and every
  // one of those requests failed with `relation "zvd_users" does not exist`.
  //
  // So the failure landed precisely on the configuration this mechanism exists
  // to make possible, and reported success while doing it. Splitting the steps
  // means a role that cannot grant membership still gets its table grants, and
  // the log names the step that actually failed.

  // 1. The role itself. Needs CREATEROLE, which a plain engine role should not
  //    have — scripts/bootstrap-db-role.sh pre-creates it for that case.
  try {
    await sql`
      DO $ensure_rls_role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
          CREATE ROLE zveltio_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END
      $ensure_rls_role$;
    `.execute(db);
  } catch (err) {
    console.warn(
      '[tenant-rls] could not create the zveltio_rls role (continuing):',
      (err as Error).message,
    );
    return; // Nothing below can succeed without it.
  }

  // 2. Membership, so `SET LOCAL ROLE zveltio_rls` is permitted. Guarded by the
  //    membership test rather than attempted blindly: a correctly configured
  //    plain role is already a member and cannot re-grant, and printing
  //    "permission denied" on every boot of a correct install is how operators
  //    learn to skim past [tenant-rls] lines.
  //
  //    SET, not MEMBER: on Postgres a role can be a MEMBER with SET FALSE —
  //    what a CREATEROLE engine holds on a role it created — and SET LOCAL ROLE
  //    then fails. MEMBER said yes, boot said "enforced", and every tenant
  //    request failed. The two narrow roles the engine also switches into (the
  //    worker SQL bridge, flow `query_db`) get the same repair, one statement
  //    each so one refusal does not skip the rest.
  for (const role of ['zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader']) {
    try {
      await sql`
        DO $ensure_role_member$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sql.lit(role)}) THEN
            IF NOT pg_has_role(current_user, ${sql.lit(role)}, 'SET') THEN
              EXECUTE format('GRANT %I TO %I WITH SET TRUE', ${sql.lit(role)}, current_user);
            END IF;
          END IF;
        END
        $ensure_role_member$;
      `.execute(db);
    } catch (err) {
      console.warn(
        `[tenant-rls] could not grant ${role} membership (continuing):`,
        (err as Error).message,
      );
    }
  }

  // 3. The privileges the role needs to be useful. The database owner can do
  //    all of this on its own objects, so it works under a plain role — and it
  //    has to re-run at every boot because extensions create tables after this
  //    ran last time.
  try {
    await sql`
      DO $ensure_rls_grants$
      DECLARE t record; s record;
      BEGIN
        GRANT USAGE ON SCHEMA public TO zveltio_rls;
        -- Every table EXCEPT the ones Better-Auth owns. This loop granting full
        -- DML on all of public is what made C-14 and C-10 reach live session
        -- tokens: the string guards had no rule for unprefixed tables, and the
        -- role underneath them could read and write every one.
        --
        -- Excluded here rather than revoked afterwards, because a revoke in a
        -- migration is undone by the next boot — this function runs at every
        -- start. Migration 044 enables RLS on the same four as the second layer.
        FOR t IN
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            -- user stays granted: it holds no credentials (the password is in
            -- account, the token in session) and the engine reads it through
            -- this role for /api/me, the user list and notification fan-out.
            -- Excluding it took /api/me to a 500. The other four are where the
            -- credentials actually are.
            -- passkey joined this list on 2026-09-04, having been missed since
            -- migration 002 created it. Measured before adding it: inside a tenant
            -- transaction this role could not read the session token and COULD
            -- insert a passkey row naming any userId - an attacker-chosen
            -- authenticator against someone else's account, which is an
            -- authentication bypass rather than a data leak.
            --
            -- The shape is the defect, not the name: this is a denylist over an
            -- open namespace, and the next Better-Auth table will be granted the
            -- same way. tests/harness/rls-role-credential-grants.test.ts pins the
            -- property instead - nothing outside zv_/zvd_ except user - so a
            -- sixth table fails there rather than arriving in silence.
            AND tablename NOT IN ('session', 'account', 'verification', 'twoFactor', 'passkey')
        LOOP
          EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zveltio_rls', t.tablename);
        END LOOP;
        FOR s IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
          EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO zveltio_rls', s.sequencename);
        END LOOP;
        -- REVOKE, not merely skip. ALTER DEFAULT PRIVILEGES (migration 001)
        -- grants DML on every table this role creates FROM NOW ON, so a
        -- credential table added by a later migration is granted at CREATE time
        -- and the skip list above never sees it. That is how passkey arrived
        -- granted in migration 002 and stayed granted: measured in CI on a fresh
        -- database, where skipping it in the loop changed nothing at all.
        --
        -- So the set is taken back explicitly, at every boot, which also heals
        -- installs that ran an older build. Migration 001 revokes the same four
        -- for exactly this reason; passkey was missing from both lists.
        FOR t IN
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename IN ('session', 'account', 'verification', 'twoFactor', 'passkey')
        LOOP
          EXECUTE format('REVOKE ALL ON public.%I FROM zveltio_rls', t.tablename);
        END LOOP;
      END
      $ensure_rls_grants$;
    `.execute(db);
  } catch (err) {
    // Not fatal, and not silent either: the caller logs the resulting mode, and
    // `warnIfDbRoleBypassesRls` says plainly what it costs.
    console.warn(
      '[tenant-rls] could not grant privileges to zveltio_rls (continuing):',
      (err as Error).message,
    );
  }
}

/** Test seam: run tenant transactions without (or with) `zveltio_rls`; returns a restore. */
export function _setRlsRoleAvailableForTests(available: boolean): () => void {
  const prev = _rlsRoleAvailable;
  _rlsRoleAvailable = available;
  return () => {
    _rlsRoleAvailable = prev;
  };
}

/** Boot check — see `_rlsRoleAvailable`. Returns the mode for logging. */
export async function initRlsEnforcementRole(
  db: Database,
): Promise<'enforced' | 'native' | 'unavailable'> {
  await ensureRlsEnforcementRole(db);
  try {
    const r = await sql<{ ok: boolean; super_user: boolean }>`
      SELECT pg_has_role(current_user, 'zveltio_rls', 'SET') AS ok,
             (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
               AS super_user
    `.execute(db);
    const row = r.rows[0];
    _rlsRoleAvailable = Boolean(row?.ok);
    if (_rlsRoleAvailable) return 'enforced';
    // No role, but the connection is already a plain one — RLS binds it
    // directly and there is nothing to fix.
    return row?.super_user ? 'unavailable' : 'native';
  } catch {
    // The role does not exist (migration 030 could not create it).
    _rlsRoleAvailable = false;
    return 'unavailable';
  }
}

/** @deprecated Use withTenantIsolation() instead. */
export async function setCurrentTenant(_tenantId: string): Promise<void> {
  throw new Error(
    'setCurrentTenant() is deprecated and non-functional. ' +
      'SET LOCAL requires an active transaction. Use withTenantIsolation() instead.',
  );
}

/**
 * Enable PostgreSQL Row-Level Security on a collection table for multi-tenant isolation.
 * Adds a tenant_id column (if missing), creates an index, enables RLS, and installs
 * a tenant_isolation policy that restricts rows to the current tenant session variable.
 *
 * Usage: call once when provisioning a new collection in multi-tenant mode.
 */
export async function enableRLS(tableName: string): Promise<void> {
  // 1. Add tenant_id FK column (idempotent)
  await sql`
    ALTER TABLE ${sql.id(tableName)}
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES zv_tenants(id) ON DELETE CASCADE
  `.execute(_db);

  // 1b. Default matches applyTenantRLS: writes without an explicit tenant_id
  // land in the current tenant instead of becoming NULL rows invisible to everyone.
  await sql`
    ALTER TABLE ${sql.id(tableName)}
    ALTER COLUMN tenant_id SET DEFAULT
      COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, ${DEFAULT_TENANT_ID}::uuid)
  `.execute(_db);

  // 2. Index for query performance
  await sql`
    CREATE INDEX IF NOT EXISTS ${sql.id(indexName(tableName, 'tenant'))}
    ON ${sql.id(tableName)}(tenant_id)
  `.execute(_db);

  // 3. Enable + FORCE RLS.
  //
  //    `ENABLE ROW LEVEL SECURITY` alone leaves a giant escape hatch:
  //    the table OWNER (and anyone with BYPASSRLS) is still exempt
  //    from policies. In Zveltio the engine connects as the owner of
  //    the public schema, so without FORCE, every query the engine
  //    makes effectively sees ALL tenants — RLS becomes advisory.
  //
  //    `FORCE ROW LEVEL SECURITY` removes that escape hatch so even
  //    the owner is bound by the policy. The only way to read across
  //    tenants is then through a connection that explicitly has the
  //    BYPASSRLS attribute (which the engine connection should NOT).
  await sql`ALTER TABLE ${sql.id(tableName)} ENABLE ROW LEVEL SECURITY`.execute(_db);
  await sql`ALTER TABLE ${sql.id(tableName)} FORCE ROW LEVEL SECURITY`.execute(_db);

  // 4. Isolation policy — the SAME predicate pair `applyTenantRLS` uses.
  //
  //    This spelled the rule out inline as
  //      tenant_id::text = current_setting('zveltio.current_tenant', true)
  //    while `applyTenantRLS` calls `zveltio_tenant_scope_ok(tenant_id)`. Two
  //    spellings of one rule is exactly what the comment on that function warns
  //    about: it records an earlier pair that "behaved oppositely when a query
  //    arrived with no tenant context", and says naming it once is what makes
  //    the divergence impossible to repeat. This site kept the old spelling, so
  //    a table enabled through THIS path got the other behaviour.
  //
  //    They are not equivalent. `current_setting(..., true)` returns NULL when
  //    the GUC is unset, and `tenant_id::text = NULL` is NULL — not false — so
  //    the row is invisible on USING while an INSERT's WITH CHECK is also NULL,
  //    which Postgres treats as a violation. `zveltio_tenant_scope_ok`
  //    (migration 029) decides that case deliberately instead of inheriting
  //    three-valued logic.
  //
  //    Since migration 003 the two halves are different functions:
  //    `zveltio_tenant_scope_ok` for reading (which may span a subtree),
  //    `zveltio_tenant_write_ok` for writing (the own node, always). Keep them
  //    apart — the reason the read half widened is the reason the write half
  //    must not.
  //
  //    DROP + CREATE so this function stays idempotent.
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.id(tableName)}`.execute(_db);
  // `sql.id` for the table, `sql.raw` for the function name only — and the
  // function name is one of two literals chosen here, never a caller's string.
  // Every other statement in this function quotes the identifier; dropping to
  // raw interpolation for the one that happens to need a second insert would
  // make this the one injectable statement of the set.
  const setFn = await visibleTenantsFn(_db, tableName);
  await sql`
    CREATE POLICY tenant_isolation ON ${sql.id(tableName)}
    USING (tenant_id = ANY (${sql.raw(setFn)}))
    WITH CHECK (zveltio_tenant_write_ok(tenant_id))
  `.execute(_db);

  // 5. NULL tenant_id row warning.
  //
  //    enableRLS is typically called AFTER the table already has data.
  //    Existing rows have tenant_id = NULL, and the policy
  //    `tenant_id::text = current_setting(...)` evaluates to NULL
  //    (not true) for them — so they become invisible to every
  //    tenant. Worse, if the operator later disables RLS or BYPASSRLS,
  //    the rows are still there with NULL tenant_id and effectively
  //    leak into any tenant query.
  //
  //    We surface this loudly so the operator runs a backfill UPDATE
  //    before considering the table multi-tenant-safe.
  // The `.catch(() => ({ rows: [{ orphan_count: 0 }] }))` this used to carry
  // answered "no orphans" when the count could not run, and the `if (orphanCount
  // > 0)` below then skipped the warning entirely. The comment above says this is
  // surfaced LOUDLY so an operator backfills before treating the table as
  // multi-tenant-safe; the catch made it silent in exactly the case where the
  // operator has least reason to suspect anything.
  let orphanCount: number;
  try {
    const orphans = await sql<{ orphan_count: number }>`
      SELECT COUNT(*)::int AS orphan_count FROM ${sql.id(tableName)} WHERE tenant_id IS NULL
    `.execute(_db);
    orphanCount = orphans.rows[0]?.orphan_count ?? 0;
  } catch (err) {
    // Not fatal — RLS is already enabled by this point and the enable itself
    // succeeded. But "I could not check" and "there is nothing to fix" must not
    // read the same to whoever is watching the log.
    console.warn(
      `[tenant-manager] enableRLS(${tableName}): could not count rows with a NULL ` +
        `tenant_id, so it is UNKNOWN whether any are now invisible to every tenant. ` +
        `Check by hand: SELECT COUNT(*) FROM ${tableName} WHERE tenant_id IS NULL. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (orphanCount > 0) {
    console.warn(
      `[tenant-manager] enableRLS(${tableName}): ${orphanCount} row(s) ` +
        `have tenant_id IS NULL and are now invisible to every tenant. ` +
        `Backfill with: UPDATE ${tableName} SET tenant_id = '<default-tenant-id>' WHERE tenant_id IS NULL`,
    );
  }
}
