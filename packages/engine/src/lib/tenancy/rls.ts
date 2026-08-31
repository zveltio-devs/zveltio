/**
 * Application-layer Row-Level Security (RLS).
 *
 * Evaluated AFTER Casbin (which grants collection-level access).
 * Injects additional WHERE conditions so users only see records they're
 * entitled to — without touching PostgreSQL's native RLS.
 *
 * Skipped for:
 *   - god users (bypass all policy layers)
 *   - api_key auth (scope-based; no user context for user_id/email filters)
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getCache } from '../runtime/index.js';
import { decodeSigned, encodeSigned } from './signed-cache.js';
import { getCurrentTenantTrx } from './tenant-context.js';
import { checkPermission, getUserRoles } from './permissions.js';
import type { FilterCondition } from '../../db/dynamic.js';

const RLS_CACHE_TTL = 30; // seconds — short TTL so policy changes apply quickly

export interface RlsPolicy {
  id: string;
  collection: string;
  role: string;
  filter_field: string;
  filter_op: string;
  filter_value_source: string;
  is_enabled: boolean;
  description?: string | null;
}

let _db: Database;

export function initRls(db: Database): void {
  _db = db;
}

/** Resolve a filter_value_source against the current user context. */
function resolveValue(
  source: string,
  user: { id: string; email?: string; role: string },
): string | null {
  if (source === 'user_id') return user.id;
  if (source === 'user_email') return user.email ?? null;
  if (source === 'user_role') return user.role;
  if (source.startsWith('static:')) return source.slice(7);
  return null;
}

/** Load all enabled policies for a collection from DB (with cache). */
async function loadPolicies(collection: string): Promise<RlsPolicy[]> {
  const cache = getCache();
  const cacheKey = `rls:policies:${collection}`;

  if (cache) {
    try {
      const raw = await cache.get(cacheKey);
      // Signed: this cache decides which row filters are applied, so anyone
      // who can write the key can remove them. A tampered entry decodes to
      // null and we fall through to the database.
      if (raw) {
        const policies = decodeSigned<RlsPolicy[]>('rls', cacheKey, raw);
        if (policies) return policies;
      }
    } catch {
      /* cache unavailable */
    }
  }

  const rows = await sql<RlsPolicy>`
    SELECT id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
    FROM zvd_rls_policies
    WHERE is_enabled = TRUE
      AND (collection = ${collection} OR collection = '*')
    ORDER BY collection DESC, role
  `.execute(_db);

  const policies = rows.rows;

  if (cache) {
    try {
      await cache.setex(cacheKey, RLS_CACHE_TTL, encodeSigned('rls', cacheKey, policies));
    } catch {
      /* cache unavailable */
    }
  }

  return policies;
}

/** Invalidate RLS policy cache for a collection (call after policy CRUD). */
export async function invalidateRlsCache(collection: string): Promise<void> {
  // Rebuild the database's copy of these rules first.
  //
  // This is the one place every rule change passes through — create, update and
  // delete all call it — so it is where the generated policy is kept in step.
  // Hooking the three routes instead would leave any other caller writing rules
  // the database does not know about, which is the failure the policy exists to
  // prevent, reintroduced one caller at a time.
  //
  // A `*` rule belongs to every collection, so every collection is rebuilt.
  //
  // Deferred a tick, and issued on the POOL. `CREATE POLICY` is DDL, which the
  // request's own role (`zveltio_rls`) may not run — so it has to be the
  // engine's own connection. Taking that connection while the request still
  // holds its transaction is the second reservation this codebase spent a block
  // removing, so it waits for the commit instead.
  //
  // The window between the rule being written and the policy being rebuilt is
  // covered by the engine, which applies the same rule itself. A failure here is
  // loud rather than fatal for the same reason.
  const refresh = async () => {
    try {
      const { applyRowRulePolicy, reconcileRowRulePolicies } = await import('./row-rule-policy.js');
      if (collection === '*') await reconcileRowRulePolicies(_db);
      else await applyRowRulePolicy(_db, collection);
    } catch (err) {
      console.warn(`[row-rules] ${collection}: policy not refreshed — ${(err as Error).message}`);
    }
  };
  try {
    if (getCurrentTenantTrx()) setTimeout(() => void refresh(), 0);
    else await refresh();
  } catch (err) {
    // Loud, and not fatal: the engine still applies the rule. Silence here would
    // mean an instance quietly running with one enforcer where it believes it
    // has two.
    console.warn(`[row-rules] ${collection}: policy not refreshed — ${(err as Error).message}`);
  }

  const cache = getCache();
  if (!cache) return;
  try {
    await cache.del(`rls:policies:${collection}`);
    await cache.del('rls:policies:*'); // also clear wildcard collection cache
  } catch {
    /* cache unavailable */
  }
  // The query cache stores already-RLS-filtered rows — drop it for this
  // collection so a policy change takes effect immediately, not after the TTL.
  const { invalidateQueryCacheForCollection } = await import('../data/index.js');
  await invalidateQueryCacheForCollection(collection);
}

/**
 * Returns extra filter conditions to inject into a query for the given user.
 * Returns an empty array when no policies match (no restriction applied).
 *
 * Multiple matching policies are ANDed together (most restrictive wins).
 */
export async function getRlsFilters(
  collection: string,
  user: { id: string; email?: string; role: string; rlsBypass?: boolean },
  authType: 'session' | 'api_key',
): Promise<Array<{ field: string; condition: FilterCondition }>> {
  // This used to read `user.role === 'god' || authType === 'api_key'`. Both
  // halves were wrong, in opposite directions.
  //
  // The god half was DEAD: `session.user.role` is never populated (not declared
  // in better-auth's additionalFields), so the branch never fired and gods were
  // subject to RLS. Restoring a hardcoded role-name check would have brought
  // back the reason nobody noticed for so long — a string comparison against a
  // role name is invisible, unauditable and impossible to revoke. The override
  // is a PERMISSION now: `checkPermission` short-circuits for god users
  // already, so a god still sees everything, while an operator can also grant
  // the same power to a named role, or decline to — which matters when someone
  // must administer an instance without reading every tenant's customer data.
  //
  // The api_key half was LIVE, and blanket: every key ignored every policy.
  // That is now per key (migration 026), defaulting to today's behaviour
  // because RLS values resolve from `user_id`/`user_email` and a key's identity
  // is the synthetic `apikey:<uuid>` — enforcing an identity policy against a
  // key returns zero rows, silently, which is a worse failure than a broad one.
  if (authType === 'api_key') {
    // `=== true` for the reason spelled out in lib/data/auth.ts: this is the
    // second reader of the same flag, and the two must not disagree about what
    // an absent value means. `rlsBypass` is optional on the type, so `!== false`
    // handed a full bypass to any caller that simply never set it.
    if (user.rlsBypass === true) return [];
  } else if (await checkPermission(user.id, 'data', 'view_all').catch(() => false)) {
    return [];
  }

  const policies = await loadPolicies(collection);
  if (policies.length === 0) return [];

  // Get user's roles from Casbin (includes inherited roles)
  let userRoles: string[];
  try {
    userRoles = await getUserRoles(user.id);
  } catch {
    userRoles = [user.role];
  }
  // Always include the direct role
  if (!userRoles.includes(user.role)) userRoles.push(user.role);

  const result: Array<{ field: string; condition: FilterCondition }> = [];

  for (const policy of policies) {
    // Match if policy role is '*' or user has that role
    const roleMatch = policy.role === '*' || userRoles.includes(policy.role);
    if (!roleMatch) continue;

    const value = resolveValue(policy.filter_value_source, user);
    if (value === null) continue; // can't resolve value — skip (fail-open for this policy)

    const op = (policy.filter_op as FilterCondition['op']) || 'eq';
    // `in`/`not_in` need a list, and resolveValue only ever produces a scalar.
    // A `static:` source is the one place a list can be expressed, so it is
    // comma-split here — for those operators only, so an `eq` policy whose
    // value legitimately contains a comma is untouched. The user_* sources are
    // single values, where a one-element list means the same as `eq`.
    const isListOp = op === 'in' || op === 'not_in';
    const condValue =
      isListOp && policy.filter_value_source.startsWith('static:')
        ? String(value)
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : value;
    result.push({ field: policy.filter_field, condition: { op, value: condValue } });
  }

  return result;
}

/**
 * Apply RLS filter conditions to a query builder.
 *
 * Extracted so the WRITE paths can reuse exactly what the read paths do. The
 * policies configured under `/api/admin/rls` were only ever applied when
 * fetching rows, so a rule like "a user sees only their own records" held for
 * GET and vanished for PATCH/PUT/DELETE — any member could modify or delete
 * another user's row by naming its id. Writes now run the same conditions on the
 * row they load first, so an invisible row is simply not found.
 *
 * Typed loosely on purpose: these queries are built over runtime-resolved table
 * names via `dynamicDb`, which has no static schema to check the field against.
 */
/** The only shape this needs from a query builder. */
type WhereChain = { where(field: string, op: string, value: unknown): WhereChain };

export function applyRlsFilters<Q>(
  query: Q,
  filters: Array<{ field: string; condition: FilterCondition }>,
): Q {
  let out = query as unknown as WhereChain;
  for (const { field, condition } of filters) {
    const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
    if (condition.op === 'eq') out = out.where(field, '=', condition.value);
    else if (condition.op === 'neq') out = out.where(field, '!=', condition.value);
    else if (condition.op === 'in') out = out.where(field, 'in', asList(condition.value));
    else if (condition.op === 'not_in') out = out.where(field, 'not in', asList(condition.value));
    else {
      // Fail CLOSED. `in` and `not_in` were accepted by the policy route
      // (routes/rls.ts validates against a four-value enum) and silently
      // dropped here, so a policy an administrator saved, saw listed as
      // enabled, and believed was hiding rows did nothing at all. A security
      // filter that cannot be applied must not let the rows through — an
      // operator can act on an error, not on a leak they cannot see.
      throw new Error(
        `RLS policy on "${field}" uses operator "${condition.op}", which this engine ` +
          `cannot apply. Refusing the query rather than returning rows the policy was ` +
          `meant to hide. Fix or disable the policy.`,
      );
    }
  }
  return out as unknown as Q;
}

/**
 * The same conditions, evaluated in memory.
 *
 * `?as_of=` reconstructs rows from the JSON snapshots in `zv_revisions` rather
 * than selecting from the table, so there is no query to attach a WHERE to —
 * and it therefore returned rows the caller's row policy withholds. Asking for
 * a snapshot as of one second ago was enough to see everything, on a parameter
 * that exists for auditing.
 *
 * Deliberately the same four operators and the same fail-closed default as
 * `applyRlsFilters`, so the two cannot drift into disagreeing about what a
 * policy means. Kept next to it for the same reason.
 */
export function matchesRlsFilters(
  record: Record<string, unknown>,
  filters: Array<{ field: string; condition: FilterCondition }>,
): boolean {
  for (const { field, condition } of filters) {
    const value = record[field];
    const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
    // Compared as text, because that is what the other two do.
    //
    // A rule's value is ALWAYS a string — the four sources are user_id,
    // user_email, user_role and static:VAL. Against an integer column, the
    // engine's WHERE sends the string and Postgres casts it, so `code = '5'`
    // matches the row where code is 5. JavaScript's `5 === '5'` does not, so the
    // same rule hid a row here and kept it there. Text comparison is the one
    // that agrees with the database.
    const same = (a: unknown, b: unknown): boolean => String(a) === String(b);
    if (condition.op === 'eq') {
      if (value === null || value === undefined) return false;
      if (!same(value, condition.value)) return false;
    } else if (condition.op === 'neq') {
      // A missing or NULL field is DROPPED, because that is what SQL does.
      //
      // `value === condition.value` alone kept such a row, while `applyRlsFilters`
      // sends `<>` and Postgres answers NULL — which a WHERE discards. So the
      // same rule hid a row on the REST path and showed it on the realtime one.
      // Measured by an independent audit, on a row with a NULL bucket: absent
      // from `/api/data`, delivered over SSE. A leak, and one the comment above
      // these two functions claimed was impossible.
      if (value === null || value === undefined) return false;
      if (same(value, condition.value)) return false;
    } else if (condition.op === 'in') {
      if (value === null || value === undefined) return false;
      if (!asList(condition.value).some((v) => same(value, v))) return false;
    } else if (condition.op === 'not_in') {
      // Same as `neq`: SQL's `NOT IN` yields NULL for a NULL field, and a WHERE
      // discards it. `includes(null)` is merely false, which kept it.
      if (value === null || value === undefined) return false;
      if (asList(condition.value).some((v) => same(value, v))) return false;
    } else {
      throw new Error(
        `RLS policy on "${field}" uses operator "${condition.op}", which this engine ` +
          `cannot apply. Refusing the query rather than returning rows the policy was ` +
          `meant to hide. Fix or disable the policy.`,
      );
    }
  }
  return true;
}

/**
 * The same conditions again, as SQL over a JSONB snapshot.
 *
 * `?as_of=` rebuilds rows from `zv_revisions.data`, so until this existed the
 * only way to apply a row policy there was to read the entire history into the
 * process and filter the array. Measured on 200 000 records with two revisions
 * each: 336 ms, of which the filtering was 2,2 ms — the reading was the cost.
 * The same page asked of the database is 2 ms.
 *
 * ── Why `->` and to_jsonb, and never `->>` ────────────────────
 *
 * A policy value is ALWAYS a string: the four sources are `user_id`,
 * `user_email`, `user_role` and `static:VAL`. `->>` renders any JSON scalar as
 * text, so `data->>'code' = '5'` is TRUE for the number 5 — while the in-memory
 * evaluator, comparing with `===`, says `5 !== '5'` and hides that row. The
 * naive translation therefore SHOWS a row the policy withholds, which is the
 * one direction a security filter must never fail in. Comparing jsonb to
 * `to_jsonb(<value>::text)` is true only for the JSON *string*, which is what
 * `===` means.
 *
 * ── Why `IS DISTINCT FROM` and the explicit NULL ──────────────
 *
 * A key missing from a snapshot is `undefined` in JS and SQL NULL here. In
 * memory `undefined === v` is false, so `neq` and `not_in` KEEP such a row.
 * Plain `<>` and `NOT IN` yield NULL for it, and a WHERE drops it. So the two
 * negative operators say so explicitly. A JSON null needs no special case: it
 * comes back as jsonb `null`, not SQL NULL, and compares like the JS `null` it
 * came from.
 *
 * Third applier of the same four operators, kept in this file with the other
 * two for the reason stated above them: they must not drift into disagreeing
 * about what a policy means. Same fail-closed default, same message.
 */
export function rlsJsonConditions(
  filters: Array<{ field: string; condition: FilterCondition }>,
  column = 'data',
): Array<ReturnType<typeof sql<boolean>>> {
  const col = sql.ref(column);
  const out: Array<ReturnType<typeof sql<boolean>>> = [];
  for (const { field, condition } of filters) {
    // `::text` is not decoration. Postgres has both `jsonb -> text` (object key)
    // and `jsonb -> integer` (array element); with an untyped parameter it
    // resolves to the integer form, which on an object returns NULL for every
    // row. That is silent: the query succeeds and the page comes back empty,
    // and a suite that only checks "these rows are hidden" passes for entirely
    // the wrong reason.
    const at = sql`${col} -> ${field}::text`;
    const one = (v: unknown) => sql`to_jsonb(${String(v)}::text)`;
    const list = (v: unknown) => sql.join((Array.isArray(v) ? v : [v]).map(one), sql`, `);

    if (condition.op === 'eq') {
      out.push(sql<boolean>`${at} = ${one(condition.value)}`);
    } else if (condition.op === 'neq') {
      out.push(sql<boolean>`${at} IS DISTINCT FROM ${one(condition.value)}`);
    } else if (condition.op === 'in') {
      out.push(sql<boolean>`${at} IN (${list(condition.value)})`);
    } else if (condition.op === 'not_in') {
      out.push(sql<boolean>`(${at} IS NULL OR ${at} NOT IN (${list(condition.value)}))`);
    } else {
      throw new Error(
        `RLS policy on "${field}" uses operator "${condition.op}", which this engine ` +
          `cannot apply. Refusing the query rather than returning rows the policy was ` +
          `meant to hide. Fix or disable the policy.`,
      );
    }
  }
  return out;
}

// ─── Admin CRUD helpers ────────────────────────────────────────────────────────

/**
 * The connection these helpers should use.
 *
 * The request's own transaction when there is one, the pool otherwise. Reading
 * on the pool while the request holds a transaction is a SECOND connection, and
 * at `c = DB_POOL_MAX` the second can never arrive — the instance stops rather
 * than slows. `zvd_rls_policies` is instance-level and readable by the request's
 * role, so there is nothing the pool gives that the transaction does not.
 */
function rlsDb(): Database {
  return getCurrentTenantTrx() ?? _db;
}

export async function listRlsPolicies(): Promise<RlsPolicy[]> {
  const rows = await sql<RlsPolicy>`
    SELECT id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description, created_at, updated_at
    FROM zvd_rls_policies
    ORDER BY collection, role
  `.execute(rlsDb());
  return rows.rows;
}

/** Thrown when a rule cannot be expressed by every layer that has to apply it. */
export class UnenforceableRuleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnenforceableRuleError';
  }
}

/**
 * Refuse a rule no layer can agree on, at the door.
 *
 * `code eq user_id` — an integer column against a user id — makes the engine's
 * query throw, the generated policy skip the rule (so it does nothing), and the
 * in-process matcher filter in JavaScript. None is wrong alone; together they
 * are one rule with three meanings. An independent audit found that class by
 * hand; the door is the only place to close it once.
 *
 * A collection with no table yet, or `*`, cannot be checked and is allowed —
 * refusing on absence would block a rule written before its collection exists.
 */
async function assertEnforceable(data: {
  collection?: string;
  role?: string;
  filter_field?: string;
  filter_op?: string;
  filter_value_source?: string;
}): Promise<void> {
  const { collection, filter_field, filter_op, filter_value_source, role } = data;
  if (!collection || collection === '*') return;
  if (!filter_field || !filter_op || !filter_value_source) return;

  const table = `zvd_${collection}`;
  const cols = await sql<{ column_name: string; data_type: string }>`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
  `.execute(rlsDb());
  if (cols.rows.length === 0) return;

  const types: Record<string, string> = {};
  for (const col of cols.rows) types[col.column_name] = col.data_type;

  const { describeRuleProblem } = await import('./row-rule-policy.js');
  const problem = describeRuleProblem(
    { role: role ?? '*', filter_field, filter_op, filter_value_source },
    types,
  );
  if (problem) throw new UnenforceableRuleError(problem);
}

export async function createRlsPolicy(data: {
  collection: string;
  role: string;
  filter_field: string;
  filter_op: string;
  filter_value_source: string;
  is_enabled?: boolean;
  description?: string;
}): Promise<RlsPolicy> {
  await assertEnforceable(data);
  const rows = await sql<RlsPolicy>`
    INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled, description)
    VALUES (
      ${data.collection}, ${data.role}, ${data.filter_field},
      ${data.filter_op}, ${data.filter_value_source},
      ${data.is_enabled ?? true}, ${data.description ?? null}
    )
    RETURNING id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
  `.execute(_db);
  await invalidateRlsCache(data.collection);
  return rows.rows[0];
}

export async function updateRlsPolicy(
  id: string,
  data: Partial<Omit<RlsPolicy, 'id'>>,
): Promise<RlsPolicy | null> {
  const rows = await sql<RlsPolicy>`
    UPDATE zvd_rls_policies
    SET
      collection          = COALESCE(${data.collection ?? null}, collection),
      role                = COALESCE(${data.role ?? null}, role),
      filter_field        = COALESCE(${data.filter_field ?? null}, filter_field),
      filter_op           = COALESCE(${data.filter_op ?? null}, filter_op),
      filter_value_source = COALESCE(${data.filter_value_source ?? null}, filter_value_source),
      is_enabled          = COALESCE(${data.is_enabled ?? null}, is_enabled),
      description         = COALESCE(${data.description ?? null}, description),
      updated_at          = NOW()
    WHERE id = ${id}
    RETURNING id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
  `.execute(_db);
  if (rows.rows[0]) await invalidateRlsCache(rows.rows[0].collection);
  return rows.rows[0] ?? null;
}

export async function deleteRlsPolicy(id: string): Promise<boolean> {
  const rows = await sql<{ collection: string }>`
    DELETE FROM zvd_rls_policies WHERE id = ${id} RETURNING collection
  `.execute(_db);
  if (rows.rows[0]) await invalidateRlsCache(rows.rows[0].collection);
  return rows.rows.length > 0;
}
