/**
 * Application-layer Row-Level Security (RLS).
 *
 * Evaluated AFTER Casbin (which grants collection-level access).
 * Injects additional WHERE conditions so users only see records they're
 * entitled to — without touching PostgreSQL's native RLS.
 *
 * Skipped for a caller holding `data:view_all` (a god holds it), and for an API
 * key with `rlsBypass` whose issuer holds it. Any other key meets its own rules
 * AND its issuer's (`getRlsFilters`).
 */

import { type RawBuilder, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getCache } from '../runtime/index.js';
import { decodeSigned, encodeSigned } from './signed-cache.js';
import { noteReconcile, startReconcile } from './reconcile-failures.js';
import { getCurrentTenantTrx, onAfterCommit } from './tenant-context.js';
import {
  checkPermission,
  getUserRoles,
  keyIssuerAllows,
  principalRole,
  revalidateSocketsEverywhere,
} from './permissions.js';
import type { FilterCondition } from '../../db/dynamic.js';
import {
  droppedForMissingValue,
  foldsCase,
  isRuleOperator,
  keepsEveryPresent,
  keepsNothing,
  RULE_OPERATORS,
  unsupportedOperator,
} from './rule-operators.js';

/** One resolved rule. `caseless`: its value is lower case, and the field is folded to match. */
export type RuleFilter = { field: string; condition: FilterCondition; caseless?: boolean };

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
  user: { id: string; email?: string; role?: string },
): string | null {
  if (source === 'user_id') return user.id;
  // `user_email` and `user_role` both answer `''` for an absent value, and
  // emphatically NOT null: null means "unknown source" to the caller, which
  // hides every row — right for a source nobody can resolve, wrong for a
  // caller who merely has no email.
  //
  // For email that was live. An API key has no email, and the WebSocket and SSE
  // paths built their session user without one, so `owner_email eq user_email`
  // held on `GET /api/data` and was dropped for every key and on both realtime
  // doors — which filter in memory, with no database policy behind them. `''`
  // matches no real owner, which is what "a caller with no email" should see.
  if (source === 'user_email') return user.email ?? '';
  // For `user_role` the value is the role `getRlsFilters` resolved, never the
  // caller's `user.role`; `''` remains only for a caller with none. The
  // Postgres side is the reason the empty string is the right answer rather
  // than a lazy one: `buildRowRulePredicate` compiles the same policy against
  // `current_setting('zveltio.user_role')`, which is `''` when unset, and
  // applies the rule with that value. `undefined` reached the condition
  // untouched before this, so a `user_role` policy was emitted as
  // `field = undefined` while its SQL twin compared against `''`.
  if (source === 'user_role') return user.role ?? '';
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

/**
 * Invalidate RLS policy cache for a collection (call after policy CRUD).
 * `policyRebuilt`: the rule's own transaction rebuilt the policy
 * (`writeRowRules`), so only what follows the commit is left to do.
 */
export async function invalidateRlsCache(
  collection: string,
  opts: { policyRebuilt?: boolean } = {},
): Promise<void> {
  // Rebuild the database's copy of these rules first, on the pool after the
  // COMMIT. A writer of the rules rebuilds it in its own transaction
  // (`writeRowRules`); this is the net for one that did not — a dropped
  // collection, a dropped field's caches — and it refreshes the previews.
  //
  // A `*` rule belongs to every collection, so every collection is rebuilt.
  //
  // On the POOL. `CREATE POLICY` is DDL, which the request's own role
  // (`zveltio_rls`) may not run — so it has to be the engine's own connection.
  // Taking that connection while the request still holds its transaction is the
  // second reservation this codebase spent a block removing, so it waits for the
  // commit instead. A failure here is loud rather than fatal.
  const refresh = async () => {
    try {
      const { applyRowRulePolicy, reconcileRowRulePolicies } = await import('./row-rule-policy.js');
      // A full rebuild that just committed clears every failure the last reconcile recorded.
      if (opts.policyRebuilt && collection === '*') startReconcile('row_rules');
      else if (opts.policyRebuilt) noteReconcile('row_rules', collection);
      else if (collection === '*') await reconcileRowRulePolicies(_db);
      else {
        await applyRowRulePolicy(_db, collection);
        // As the column layers do: a success clears the boot's failure in `db_rules`.
        noteReconcile('row_rules', collection);
      }
    } catch (err) {
      const message =
        collection === '*' ? (err as Error).message : noteReconcile('row_rules', collection, err);
      console.warn(`[row-rules] ${collection}: policy not refreshed — ${message}`);
    }
    // Then the previews, as `invalidateColumnPermCache` does: a branch copied
    // `public`'s policies when its preview was enabled, and kept them. It
    // records its own failures (`branch_protections`).
    const { refreshBranchProtections } = await import('../data/index.js');
    await refreshBranchProtections(_db, collection === '*' ? undefined : `zvd_${collection}`);
  };
  try {
    // After the COMMIT, not after a tick. `setTimeout(0)` fired with the
    // transaction still open — measured by an independent audit — so the DDL
    // took a second pooled connection, which is what deferring was for.
    if (getCurrentTenantTrx()) onAfterCommit(refresh);
    else await refresh();
  } catch (err) {
    // Loud, and not fatal: the engine still applies the rule. Silence here would
    // mean an instance quietly running with one enforcer where it believes it
    // has two.
    console.warn(`[row-rules] ${collection}: policy not refreshed — ${(err as Error).message}`);
  }

  await dropRlsCaches(collection);

  // Open realtime subscriptions filter with the rules they resolved when they
  // opened, and nothing re-resolved them: a rule written here reached an open
  // socket or stream only when its client reconnected. Swept once the rule is
  // visible — after the commit — and with the caches dropped again first,
  // since a read between the drop above and the commit can have put the old
  // rules back, and the sweep would then pin them.
  if (getCurrentTenantTrx()) {
    onAfterCommit(async () => {
      await dropRlsCaches(collection);
      revalidateSocketsEverywhere();
    });
  } else revalidateSocketsEverywhere();
}

async function dropRlsCaches(collection: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    // Rules are cached per collection, and each entry holds that collection's
    // `*` rules too — so a `*` change stales every entry. `DEL` takes no
    // pattern: `del('rls:policies:*')` removed only the entry of the literal
    // collection `*`.
    const keys = [`rls:policies:${collection}`];
    if (collection === '*') {
      let cursor = '0';
      do {
        const [next, batch] = await cache.scan(cursor, 'MATCH', 'rls:policies:*', 'COUNT', 200);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
    } else keys.push('rls:policies:*');
    await cache.del(...keys);
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
  user: {
    id: string;
    email?: string;
    role?: string;
    rlsBypass?: boolean;
    authorUserId?: string | null;
  },
  authType: 'session' | 'api_key',
): Promise<RuleFilter[]> {
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
    // And only while its issuer holds the session's exemption: a key never
    // exceeds the person it acts for (`keyIssuerAllows`).
    if (
      user.rlsBypass === true &&
      (await keyIssuerAllows(user, 'data', 'view_all').catch(() => false))
    )
      return [];
  } else if (await checkPermission(user.id, 'data', 'view_all').catch(() => false)) {
    return [];
  }

  const policies = await loadPolicies(collection);
  if (policies.length === 0) return [];

  // Get user's roles from Casbin (includes inherited roles).
  //
  // No catch. A rule keyed on a role restricts the holders of that role, and a
  // rule whose role the caller lacks is skipped below — so reading a failed
  // lookup as `[]` stood down every role-keyed rule and served the rows they
  // hide. A rejection here refuses the request, as a failed policy load does.
  //
  // Plus the DIRECT role, resolved here and never read off `user`. It used to
  // be `user.role` from whatever object the caller passed: the realtime doors
  // resolved it, REST passed the session user, where better-auth leaves it
  // undefined, so a `member` rule filtered a socket and stood down on
  // `GET /api/data`. Casbin is the one source of roles (`member` is a
  // `g <user> member *` row); the database policy publishes the same set
  // (middleware/tenant.ts).
  //
  // A key's role is `api_key` by construction — see `principalRole`. Only that
  // one is added: the user's single role is drawn FROM the set (or is `god`,
  // which is no role, or `public`, which a signed-in user does not hold).
  const direct = await principalRole(user.id);
  const userRoles = new Set(await getUserRoles(user.id));
  if (direct === 'api_key') userRoles.add(direct);
  const result = rulesFor(policies, {
    id: user.id,
    email: user.email,
    role: direct,
    roles: userRoles,
  });
  if (authType !== 'api_key') return result;

  // A key never exceeds its issuer, and a rule binding the issuer binds what
  // they hand out. The key's own rules above are `api_key`'s and `*`, against
  // the key's identity; the issuer's are ANDed on, as the issuer: their roles,
  // their id, their email. Without this half a member whose rule shows them one
  // bucket minted a key that read every bucket. The database policy applies the
  // same half (`buildRowRulePredicate`, published by `publishApiKeyActor`).
  const issuer = await keyIssuerRowActor(user);
  if (issuer === null) result.push({ field: 'id', condition: { op: 'in', value: [] } });
  else if (issuer !== 'exempt')
    result.push(...rulesFor(policies, { ...issuer, roles: new Set(issuer.roles) }));
  return result;
}

/** Who a row rule's value sources resolve against, and the roles it is matched on. */
export interface RowActor {
  id: string;
  email: string;
  role: string;
  roles: string[];
}

/**
 * The issuer's half of a key's row rules: the issuer as their own session would
 * be resolved. `'exempt'` where that half stands down — the issuer holds
 * `data:view_all`, the permission that exempts their session; or the key is a
 * job (`apikey:job:`), which has no issuer and is bounded by its manifest, as
 * `keyIssuerAllows` treats it. `null` when the issuer is unknown: the caller
 * hides every row a rule covers.
 *
 * No catch on the roles, as for a session: a failed lookup refuses the request
 * rather than standing every role-keyed rule down.
 */
export async function keyIssuerRowActor(key: {
  id: string;
  authorUserId?: string | null;
}): Promise<RowActor | 'exempt' | null> {
  if (key.id.startsWith('apikey:job:')) return 'exempt';
  const issuer = key.authorUserId;
  if (!issuer) return null;
  if (await checkPermission(issuer, 'data', 'view_all').catch(() => false)) return 'exempt';
  const [role, roles, email] = await Promise.all([
    principalRole(issuer),
    getUserRoles(issuer),
    sql<{ email: string | null }>`SELECT email FROM "user" WHERE id = ${issuer}`
      .execute(_db)
      .then((r) => r.rows[0]?.email ?? ''),
  ]);
  return { id: issuer, email, role, roles };
}

/** The filters `policies` impose on `actor`: every rule whose role it holds. */
function rulesFor(
  policies: RlsPolicy[],
  actor: { id: string; email?: string; role: string; roles: Set<string> },
): RuleFilter[] {
  const userRoles = actor.roles;
  const result: RuleFilter[] = [];

  for (const policy of policies) {
    // Match if policy role is '*' or user has that role
    const roleMatch = policy.role === '*' || userRoles.has(policy.role);
    if (!roleMatch) continue;

    const value = resolveValue(policy.filter_value_source, actor);
    if (value === null) {
      // A source this engine does not know — a row stored before the route
      // refused them (`user.id`), or written straight into the table. It used to
      // be SKIPPED, and the generated policy left it out too, so a rule listed as
      // enabled hid nothing. It now hides everything: `in []` is the one
      // condition all four appliers read as "no row" (rule-operators.ts).
      //
      // Not a throw, although `unsupportedOperator` throws: a throw here would
      // refuse the whole request or stream over one broken rule, while `in []`
      // hides only what the rule covers — and the fan-out loops run the matcher
      // outside any try, so a throw there would stop delivery to every other
      // subscriber.
      if (!warnedUnknownSource.has(policy.id)) {
        warnedUnknownSource.add(policy.id);
        console.warn(
          `[rls] policy ${policy.id} on ${policy.collection}: value source ` +
            `${JSON.stringify(policy.filter_value_source)} is not known — hiding every row ` +
            `until it is fixed or disabled.`,
        );
      }
      result.push({ field: policy.filter_field, condition: { op: 'in', value: [] } });
      continue;
    }

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
    if (foldsCase(policy.filter_value_source)) {
      const lower = String(condValue).toLowerCase();
      result.push({ field: policy.filter_field, condition: { op, value: lower }, caseless: true });
    } else result.push({ field: policy.filter_field, condition: { op, value: condValue } });
  }

  return result;
}

/** Policies already reported, so a broken one warns once, not per request. */
const warnedUnknownSource = new Set<string>();

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
type WhereChain = {
  where(field: string | RawBuilder<unknown>, op: string, value: unknown): WhereChain;
  where(expr: unknown): WhereChain;
};

export function applyRlsFilters<Q>(query: Q, filters: RuleFilter[]): Q {
  let out = query as unknown as WhereChain;
  for (const { field, condition, caseless } of filters) {
    const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
    if (keepsNothing(condition.op, condition.value)) {
      out = out.where(sql<boolean>`false`);
    } else if (keepsEveryPresent(condition.op, condition.value)) {
      out = out.where(field, 'is not', null);
    } else if (isRuleOperator(condition.op)) {
      const op = RULE_OPERATORS[condition.op];
      out = out.where(
        caseless ? sql`lower(${sql.ref(field)}::text)` : field,
        op.kysely,
        op.list ? asList(condition.value) : condition.value,
      );
    } else {
      throw unsupportedOperator(field, condition.op);
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
export function matchesRlsFilters(record: Record<string, unknown>, filters: RuleFilter[]): boolean {
  for (const { field, condition, caseless } of filters) {
    if (!isRuleOperator(condition.op)) throw unsupportedOperator(field, condition.op);
    const raw = record[field];
    const value = caseless && !droppedForMissingValue(raw) ? String(raw).toLowerCase() : raw;
    // A missing or NULL field drops the row, on EVERY operator including the
    // negatives — the rule that had to be written by hand here and was written
    // wrong. See rule-operators.ts.
    if (droppedForMissingValue(value)) return false;
    if (!RULE_OPERATORS[condition.op].keep(value, condition.value)) return false;
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
 * ── Why `->>` and text, and no longer `->` + to_jsonb ─────────
 *
 * A policy value is ALWAYS a string: the four sources are `user_id`,
 * `user_email`, `user_role` and `static:VAL`. Both other appliers compare it as
 * TEXT — the engine sends the string and Postgres casts it against the typed
 * column, so `code = '5'` matches the row where code is 5; the in-memory
 * evaluator compares `String(a) === String(b)` for exactly that reason. `->>`
 * renders a JSON scalar as text and agrees with both.
 *
 * This used to read `-> ` compared against `to_jsonb(<value>::text)`, matching
 * only the JSON *string* "5" and never the number 5. That was aligned to an
 * in-memory evaluator which then compared with `===`. It no longer does: an
 * independent audit found `===` wrong and it became a text comparison, and this
 * applier — in another file, uncompared — kept the old meaning. `code eq
 * static:5` then showed the row on `/api/data` and hid it under `?as_of=`.
 *
 * ── Why the negative operators drop a missing key ─────────────
 *
 * A key missing from a snapshot is `undefined` in JS and SQL NULL here, and
 * SQL DROPS such a row from `<>` and `NOT IN`: the comparison is NULL and a
 * WHERE discards it. `IS DISTINCT FROM` and an explicit `IS NULL OR` used to be
 * here to KEEP it, because that is what the in-memory evaluator did.
 *
 * That evaluator was WRONG, and it is the finding the audit opened with: a row
 * with a NULL field was absent from `/api/data` and delivered over SSE. Three
 * appliers were corrected; this fourth one was not, so the same leak survived
 * on the `?as_of=` path — the one that exists for auditing. Measured across the
 * full operator x source x column-type x NULL matrix: 18 of 56 cases disagreed,
 * twelve of them this way.
 *
 * So the negatives now say nothing special, and SQL's own semantics — the ones
 * the other three follow — apply.
 *
 * FOURTH applier of the same four operators. The comment here used to say
 * "third", written before the policy generator existed in `row-rule-policy.ts`.
 * Adjacency was supposed to stop them drifting; it did not, because the fourth
 * was not adjacent and nothing compared them. `row-rules-three-interpreters`
 * now walks all four over the whole matrix, which is what actually stops it.
 */
export function rlsJsonConditions(
  filters: RuleFilter[],
  column = 'data',
): Array<ReturnType<typeof sql<boolean>>> {
  const col = sql.ref(column);
  const out: Array<ReturnType<typeof sql<boolean>>> = [];
  for (const { field, condition, caseless } of filters) {
    if (!isRuleOperator(condition.op)) throw unsupportedOperator(field, condition.op);
    if (keepsNothing(condition.op, condition.value)) {
      out.push(sql<boolean>`false`);
      continue;
    }
    if (keepsEveryPresent(condition.op, condition.value)) {
      out.push(sql<boolean>`${col} ->> ${field}::text IS NOT NULL`);
      continue;
    }
    const op = RULE_OPERATORS[condition.op];
    // `::text` is not decoration. Postgres has both `jsonb -> text` (object key)
    // and `jsonb -> integer` (array element); with an untyped parameter it
    // resolves to the integer form, which on an object returns NULL for every
    // row. That is silent: the query succeeds and the page comes back empty,
    // and a suite that only checks "these rows are hidden" passes for entirely
    // the wrong reason.
    const at = caseless ? sql`lower(${col} ->> ${field}::text)` : sql`${col} ->> ${field}::text`;
    const one = (v: unknown) => sql`${String(v)}::text`;
    const rendered = sql.raw(op.sql);
    // No special case for a missing key on any of the four: `->>` gives NULL,
    // and SQL drops a NULL comparison from a WHERE. That is what the live-table
    // path does, so it is what this must do.
    if (op.list) {
      const items = (Array.isArray(condition.value) ? condition.value : [condition.value]).map(one);
      out.push(sql<boolean>`${at} ${rendered} (${sql.join(items, sql`, `)})`);
    } else {
      out.push(sql<boolean>`${at} ${rendered} ${one(condition.value)}`);
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
async function assertEnforceable(
  data: {
    collection?: string;
    role?: string;
    filter_field?: string;
    filter_op?: string;
    filter_value_source?: string;
  },
  db: Database = rlsDb(),
): Promise<void> {
  const { collection, filter_field, filter_op, filter_value_source, role } = data;
  const { describeRuleProblem, emptyStaticList } = await import('./row-rule-policy.js');
  // Before the early returns: it needs no table, and a `*` rule is the one
  // most likely to carry it everywhere.
  const empty = filter_op && filter_value_source && emptyStaticList(filter_op, filter_value_source);
  if (empty) throw new UnenforceableRuleError(empty);
  if (!collection || collection === '*') return;
  if (!filter_field || !filter_op || !filter_value_source) return;

  const table = `zvd_${collection}`;
  const cols = await sql<{ column_name: string; data_type: string }>`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
  `.execute(db);
  if (cols.rows.length === 0) return;

  const types: Record<string, string> = {};
  for (const col of cols.rows) types[col.column_name] = col.data_type;

  const problem = describeRuleProblem(
    { role: role ?? '*', filter_field, filter_op, filter_value_source },
    types,
  );
  if (problem) throw new UnenforceableRuleError(problem);
}

/**
 * Change row rules with `write`, and rebuild the database's copy of them — the
 * `zv_row_rules` policy of every collection it names, of every collection for
 * `*` — in the same transaction: the rule and its enforcement commit together
 * or not at all. The policy used to follow the COMMIT, and a table busy past
 * the lock bound kept enforcing the old rules until the next boot while the
 * change was answered as a success; now that table fails the change (55P03).
 *
 * On the pool, as the owner: `CREATE POLICY` is the owner's DDL, and every
 * writer of the rules runs there (`/api/admin/rls` and schema apply hold no
 * request transaction).
 */
async function writeRowRules<T>(
  write: (trx: Database) => Promise<{ result: T; collections: string[] }>,
): Promise<T> {
  const { applyRowRulePolicies, lockRowRules } = await import('./row-rule-policy.js');
  const out = await _db.transaction().execute(async (trx) => {
    // Against a create or adoption in flight: neither would see the other.
    await lockRowRules(trx, 'write');
    const done = await write(trx);
    await applyRowRulePolicies(trx, done.collections);
    return done;
  });
  for (const c of new Set(out.collections)) await invalidateRlsCache(c, { policyRebuilt: true });
  return out.result;
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
  return writeRowRules(async (trx) => {
    await assertEnforceable(data, trx);
    const rows = await sql<RlsPolicy>`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled, description)
      VALUES (
        ${data.collection}, ${data.role}, ${data.filter_field},
        ${data.filter_op}, ${data.filter_value_source},
        ${data.is_enabled ?? true}, ${data.description ?? null}
      )
      RETURNING id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
    `.execute(trx);
    return { result: rows.rows[0], collections: [data.collection] };
  });
}

export async function updateRlsPolicy(
  id: string,
  data: Partial<Omit<RlsPolicy, 'id'>>,
): Promise<RlsPolicy | null> {
  // Read, checked and written in one transaction, the row locked from the read.
  //
  // The read was a statement of its own, so a move that committed between it
  // and the UPDATE was invisible: the collection this rebuilt as "left" was the
  // one before that move, and the one the rule was really leaving kept a
  // policy built from it. `FOR UPDATE` waits for that move and then reads past
  // it; the check below is then on the rule as it will be stored, too.
  return writeRowRules(async (trx) => {
    const cur = (
      await sql<RlsPolicy>`
        SELECT collection, role, filter_field, filter_op, filter_value_source
          FROM zvd_rls_policies WHERE id = ${id} FOR UPDATE
      `.execute(trx)
    ).rows[0];
    if (!cur) return { result: null, collections: [] };
    // The rule as it will be after the update, through the same door as a create.
    // PATCH used to skip it, so any rule `createRlsPolicy` refuses could be
    // stored in two steps.
    await assertEnforceable(
      {
        collection: data.collection ?? cur.collection,
        role: data.role ?? cur.role,
        filter_field: data.filter_field ?? cur.filter_field,
        filter_op: data.filter_op ?? cur.filter_op,
        filter_value_source: data.filter_value_source ?? cur.filter_value_source,
      },
      trx,
    );
    const next = (
      await sql<RlsPolicy>`
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
      `.execute(trx)
    ).rows[0];
    // A rule moved to another collection leaves one too, and that one has to
    // stop enforcing it.
    return { result: next ?? null, collections: next ? [next.collection, cur.collection] : [] };
  });
}

export async function deleteRlsPolicy(id: string): Promise<boolean> {
  return writeRowRules(async (trx) => {
    const gone = (
      await sql<{ collection: string }>`
        DELETE FROM zvd_rls_policies WHERE id = ${id} RETURNING collection
      `.execute(trx)
    ).rows[0];
    return { result: !!gone, collections: gone ? [gone.collection] : [] };
  });
}
