/**
 * Resolving an assignment into the two sets a request reads with.
 *
 * The model (docs/platform/multi-tenancy.md §5): units form a tree,
 * and what is configured is not the tree but the REACH of each assignment —
 * `self`, `subtree`, `list` or `org`. Writing has no reach at all; that half
 * lives in `zveltio_tenant_write_ok` and needs nothing from this file.
 *
 * Resolved once per request and published as two GUCs, so the predicate does
 * zero lookups per row. Deliberately NOT carried in the session token: a reach
 * baked into a token is irrevocable until it expires, which trades a
 * millisecond per request for a revocation window measured in hours.
 * `valid_from` / `valid_to` exist precisely so that withdrawing an assignment
 * is a date rather than a retelling.
 */

import { type RawBuilder, sql } from 'kysely';
import type { Database } from '../../db/index.js';

/**
 * THE definition of a membership in force: `valid_from` inclusive, `valid_to`
 * exclusive, NULL `valid_to` open-ended. Every check of "is this user in this
 * tenant now" — the membership middleware, a flow's role audience, a broadcast
 * audience, the unit switcher — uses this, so a withdrawal by date means the
 * same thing at every door.
 *
 * `table` is the alias the query gives `zv_tenant_users` (or the bare name).
 * Not used where history is the question: a tenant purge counts every row.
 */
export function activeMembership(table = 'zv_tenant_users'): RawBuilder<boolean> {
  const from = sql.ref(`${table}.valid_from`);
  const to = sql.ref(`${table}.valid_to`);
  return sql<boolean>`(${from} <= now() AND (${to} IS NULL OR ${to} > now()))`;
}

/**
 * Published when a user's assignments have all expired.
 *
 * An empty GUC cannot mean "sees nothing": `NULLIF(guc, '')` reads a blank
 * string as "no set published", which falls through to the equality predicate
 * and shows the user their own unit — the opposite of what an expired
 * assignment must do. A set containing only a unit that cannot exist says the
 * same thing in the one vocabulary the predicate already speaks, and keeps the
 * decision in the policy rather than in an `if` in the middleware.
 *
 * Published by `zveltio_tenant_reach()` (migration 052), which spells it again.
 */
export const NO_UNITS = '00000000-0000-0000-0000-000000000000';

export interface TenantScope {
  /**
   * Units this request may READ.
   *
   * `null` means: publish nothing, behave exactly as before this feature
   * existed. That is the path for every caller with no user to resolve —
   * background workers, boot reconcilers, API keys, single-tenant installs —
   * and it is why the migration is invisible to them.
   */
  visible: string[] | null;
  /** The chain above the current unit, for collections marked inherited downward. */
  ancestors: string[];
}

/** The reach as the GUC spelling. `visible_csv` NULL means: publish no set. */
export interface ScopeRow {
  visible_csv: string | null;
  ancestors_csv: string;
}

/**
 * The reach as ONE single-row statement, so it can ride inside the `set_config`
 * that publishes it.
 *
 * It used to be a membership query, an ancestor walk, a count when nothing was
 * in force and an org/subtree follow-up — up to four round trips before the
 * `set_config`, on every authenticated request. The branches now live in
 * `zveltio_tenant_reach()` (migration 052), which keeps them in the order this
 * file took them: no row → no set; rows, none in force → `NO_UNITS`; otherwise
 * the widest reach in force, `list` reaches merged. A function rather than the
 * same logic inlined here, because an inlined statement is planned on every
 * request — measured 0.7 ms warm, for branches most callers never take.
 *
 * It also fixes `list`, which never worked: the driver returns `uuid[]` as the
 * string `{…}`, and spreading that string published its characters as tenant
 * ids, so every policed read of a `list` user failed its uuid cast.
 */
export function tenantScopeQuery(userId: string, tenantId: string): RawBuilder<ScopeRow> {
  return sql<ScopeRow>`
    SELECT r.visible_csv, r.ancestors_csv FROM zveltio_tenant_reach(${userId}, ${tenantId}) AS r
  `;
}

/** God's reach: every unit and no ancestors, in the same row shape. */
export function godScopeQuery(): RawBuilder<ScopeRow> {
  return sql<ScopeRow>`
    SELECT (SELECT coalesce(string_agg(id::text, ','), '') FROM zv_tenants) AS visible_csv,
           ''::text AS ancestors_csv
  `;
}

/** No user named: no set published and no walk, in the same row shape. */
export function noScopeQuery(): RawBuilder<ScopeRow> {
  return sql<ScopeRow>`SELECT NULL::text AS visible_csv, ''::text AS ancestors_csv`;
}

export function scopeFromRow(row: ScopeRow): TenantScope {
  const split = (csv: string | null) => (csv ?? '').split(',').filter(Boolean);
  return {
    visible: row.visible_csv === null ? null : split(row.visible_csv),
    ancestors: split(row.ancestors_csv),
  };
}

/**
 * The reach on its own, in one round trip. `withTenantIsolation` folds the same
 * query into its `set_config` instead of calling this.
 *
 * Runs as the engine's own role, before a transaction drops to `zveltio_rls`.
 * `zv_tenant_users` deliberately carries no policy — it answers "which units am
 * I in?", a question asked before a unit is chosen — but the recursive walks
 * read `zv_tenants`, and depending on grants held by the restricted role would
 * make the reach silently narrow on an install where migration 030 never ran.
 */
export async function resolveTenantScope(
  db: Database,
  userId: string,
  tenantId: string,
): Promise<TenantScope> {
  const r = await tenantScopeQuery(userId, tenantId).execute(db);
  return scopeFromRow(r.rows[0] ?? { visible_csv: null, ancestors_csv: '' });
}

/** The GUC spelling: a comma-separated list, parsed by `string_to_array` in the predicate. */
export function encodeTenantSet(ids: string[] | null): string {
  return ids === null ? '' : ids.join(',');
}
