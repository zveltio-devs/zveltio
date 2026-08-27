/**
 * Resolving an assignment into the two sets a request reads with.
 *
 * The model (docs/private/TENANCY-HIERARCHY-DESIGN.md §3): units form a tree,
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

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

/**
 * Published when a user's assignments have all expired.
 *
 * An empty GUC cannot mean "sees nothing": `NULLIF(guc, '')` reads a blank
 * string as "no set published", which falls through to the equality predicate
 * and shows the user their own unit — the opposite of what an expired
 * assignment must do. A set containing only a unit that cannot exist says the
 * same thing in the one vocabulary the predicate already speaks, and keeps the
 * decision in the policy rather than in an `if` in the middleware.
 */
const NO_UNITS = '00000000-0000-0000-0000-000000000000';

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

interface AssignmentRow {
  read_scope: string;
  scope_list: string[] | null;
}

/**
 * One round trip: the currently-valid assignments for this user in this unit,
 * whether any assignment exists at all, and the ancestor chain.
 *
 * Runs BEFORE the transaction drops to `zveltio_rls`, as the engine's own role.
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
  const [assignments, ancestors] = await Promise.all([
    sql<AssignmentRow>`
      SELECT read_scope, scope_list
        FROM zv_tenant_users
       WHERE user_id = ${userId}
         AND tenant_id = ${tenantId}::uuid
         AND valid_from <= now()
         AND (valid_to IS NULL OR valid_to > now())
    `.execute(db),
    sql<{ id: string }>`
      SELECT a::text AS id FROM zveltio_tenant_ancestors(${tenantId}::uuid) AS a
    `.execute(db),
  ]);

  const ancestorIds = ancestors.rows.map((r) => r.id).filter(Boolean);
  const rows = assignments.rows;

  // No assignment row at all. Not the same as an expired one: this is a god
  // user (exempt from the membership check), an API key, or a single-tenant
  // install where nobody was ever enrolled. Publish nothing and let the
  // equality predicate answer, which is what all three did yesterday.
  if (rows.length === 0) {
    const hasAny = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_tenant_users
       WHERE user_id = ${userId} AND tenant_id = ${tenantId}::uuid
    `.execute(db);
    if ((hasAny.rows[0]?.n ?? 0) === 0) return { visible: null, ancestors: ancestorIds };
    // Enrolled, but no assignment is valid right now.
    return { visible: [NO_UNITS], ancestors: ancestorIds };
  }

  // Several assignments in one unit are combined by taking the WIDEST reach.
  // They are grants, not filters — a person given both `self` and `subtree`
  // has been given `subtree`.
  const widest = pickWidest(rows);

  if (widest.read_scope === 'org') {
    const all = await sql<{ id: string }>`SELECT id::text AS id FROM zv_tenants`.execute(db);
    return { visible: all.rows.map((r) => r.id), ancestors: ancestorIds };
  }

  if (widest.read_scope === 'subtree') {
    const sub = await sql<{ id: string }>`
      SELECT s::text AS id FROM zveltio_tenant_subtree(${tenantId}::uuid) AS s
    `.execute(db);
    return { visible: dedupe([tenantId, ...sub.rows.map((r) => r.id)]), ancestors: ancestorIds };
  }

  if (widest.read_scope === 'list') {
    // The own unit is always in the set. A reach that could not read back what
    // it just wrote would not be a narrower reach, it would be a broken one —
    // writes land on the own node by construction.
    return {
      visible: dedupe([tenantId, ...(widest.scope_list ?? [])]),
      ancestors: ancestorIds,
    };
  }

  return { visible: [tenantId], ancestors: ancestorIds };
}

const REACH_ORDER: Record<string, number> = { self: 0, list: 1, subtree: 2, org: 3 };

function pickWidest(rows: AssignmentRow[]): AssignmentRow {
  let best = rows[0];
  for (const r of rows) {
    if ((REACH_ORDER[r.read_scope] ?? 0) > (REACH_ORDER[best.read_scope] ?? 0)) best = r;
  }
  // Two `list` assignments are a union, not a contest.
  if (best.read_scope === 'list') {
    const merged: string[] = [];
    for (const r of rows) {
      if (r.read_scope === 'list' && r.scope_list) merged.push(...r.scope_list);
    }
    return { read_scope: 'list', scope_list: merged };
  }
  return best;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

/** The GUC spelling: a comma-separated list, parsed by `string_to_array` in the predicate. */
export function encodeTenantSet(ids: string[] | null): string {
  return ids === null ? '' : ids.join(',');
}
