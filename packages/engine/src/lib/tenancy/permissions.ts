import { createHmac, timingSafeEqual } from 'crypto';
import { Helper, newEnforcer, newModelFromString, type Enforcer } from 'casbin';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { problem } from '../problem.js';
import {
  ACCESS_RULES_CHANGED_EVENT,
  getCache,
  POLICY_CHANGED_EVENT,
  realtimeBus,
} from '../runtime/index.js';
import { getCurrentDomain, getCurrentDomainOrNull } from './tenant-context.js';
import { DEFAULT_TENANT_ID } from './tenant-manager.js';

// Cache TTLs
const PERMISSION_CACHE_TTL = 60; // seconds

/**
 * The same memo, in process, for a deployment with no Valkey.
 *
 * `checkPermission` is one `enforce()` over every loaded policy, and measured on
 * a 7 208-policy instance that call costs **364 ms** — all of it single-threaded
 * CPU on the request thread. Nothing memoized it: asking twice for the same
 * resource cost the same twice. The Valkey branch below was the only thing
 * standing between that and every authenticated request, so an install without
 * a cache answered a plain 401 in 348 ms and served three requests a second, at
 * any concurrency.
 *
 * Deliberately active ONLY when there is no shared cache. A per-process memo in
 * a multi-instance deployment would answer from an instance that never saw the
 * revocation, and a revoked permission served for a whole TTL is a worse bug
 * than the one being fixed. With no Valkey the engine is single-instance
 * anyway — `realtime-bus` says so in as many words — so in-process invalidation
 * is complete invalidation, and every path that clears the shared cache clears
 * this one first.
 */
export const LOCAL_PERM_MAX = 10_000;
const _localPerm = new Map<string, { value: boolean; expires: number }>();

function localPermGet(key: string): boolean | null {
  const hit = _localPerm.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    _localPerm.delete(key);
    return null;
  }
  return hit.value;
}

function localPermSet(key: string, value: boolean): void {
  // Bounded: a Map that only grows is a leak wearing a cache's clothes. Map
  // preserves insertion order, so the first key is the oldest written.
  if (_localPerm.size >= LOCAL_PERM_MAX) {
    const oldest = _localPerm.keys().next().value;
    if (oldest !== undefined) _localPerm.delete(oldest);
  }
  _localPerm.set(key, { value, expires: Date.now() + PERMISSION_CACHE_TTL * 1000 });
}

/**
 * Drop in-process permission answers — all of them, or one user's.
 *
 * Called from every path that invalidates the shared cache, INCLUDING the ones
 * that used to return early when no cache was configured. That early return is
 * exactly how a memo like this turns into a security bug.
 */
/**
 * Test seam: how many answers the memo is holding.
 *
 * Not part of the contract — it exists because the eviction cap is 10 000 and a
 * test that filled it honestly would need 10 000 uncached `enforce()` calls at
 * ~370 ms each. The bookkeeping is what a test can check cheaply; the cap itself
 * is four lines above and holds by construction.
 */
/**
 * Every `p.obj` the loaded policies actually name.
 *
 * The memo above rescues repeated checks, and a `checkPermission` that is asked
 * the SAME question twice is now free. It does nothing for a caller that varies
 * the question, and that is the shape of the attack: measured on the live
 * engine, hitting `/api/data/<random>` runs at **2 req/s with p50 5,5 s**, while
 * the same path with a fixed name runs at 67 req/s. Every distinct name is a
 * fresh 364 ms `enforce()`.
 *
 * The matcher makes the collapse safe. Object comparison is plain equality —
 *
 *   (r.obj == p.obj || (p.obj == '*' && p.act == '*'))
 *
 * — with no `keyMatch` and no pattern anywhere. So for any resource name that no
 * policy names literally, the only rules that can match are the `'*'` ones, and
 * the answer therefore does not depend on the name at all. All such names share
 * one memo entry per (domain, user, action), and the attack collapses to a
 * single `enforce()` no matter how many names are invented.
 *
 * `enforce()` is still called with the REAL resource — the collapse is in where
 * the answer is filed, never in how it is computed.
 */
const UNKNOWN_RESOURCE = '\u0000unnamed';
let _policyObjects: Set<string> | null = null;

/**
 * Bumped on every clear. An answer is memoized only if no clear happened while
 * it was being computed: the enforcer is read across awaits (role lookups are
 * async), so a revoke applied mid-check — by a bus message from another
 * instance, or a local write — would otherwise be cached AFTER the clear that
 * was meant to drop it, and served for the whole TTL.
 */
let _policyGen = 0;

/**
 * Where this process files its answers in the SHARED cache, and why it has one.
 *
 * Keys carry the instance and its policy generation, so a clear is a bump and
 * nothing more: the old keys are never read again and die by TTL. The shared
 * copy used to be purged with a SCAN on every instance for every change —
 * because a replica that had not heard yet wrote its stale answer back into the
 * shared key after the publisher purged it, and everyone then served it. An
 * instance now only ever reads what its own enforcer computed in its current
 * generation, and every change it applies bumps that generation.
 */
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);
function cacheNamespace(): string {
  return `${INSTANCE_ID}.${_policyGen}`;
}

/** Test seam: the namespace cache keys are written under right now. */
export function __cacheNamespace(): string {
  return cacheNamespace();
}

/**
 * The current policy generation. A decision cached outside this module (the
 * WebSocket subscribe cache) is valid only while this still returns the value
 * read before the decision was computed.
 */
export function permissionGeneration(): number {
  return _policyGen;
}

/** Dropped whenever policies change, so a newly named resource stops collapsing. */
function invalidatePolicyObjectIndex(): void {
  _policyObjects = null;
}

async function policyObjectIndex(): Promise<Set<string>> {
  if (_policyObjects) return _policyObjects;
  const gen = _policyGen;
  const e = await getEnforcer();
  const index = new Set<string>();
  for (const rule of await e.getPolicy()) {
    const obj = rule[2];
    if (typeof obj === 'string') index.add(obj);
  }
  if (gen === _policyGen) _policyObjects = index;
  return index;
}

/**
 * Everything one subject may do in one domain, resolved once.
 *
 * `enforce()` is `some(where p.eft == allow)`, so it stops at the first policy
 * that matches — which is why a user WITH a matching role answers in 8 ms and a
 * user without one takes 364-885 ms: a denial has to read all 7 208 policies to
 * establish that none of them applies. Denials are the expensive case, and
 * denials are the case an attacker picks.
 *
 * Casbin's own `getImplicitPermissionsForUser` cannot be used to precompute this.
 * The `p` rules here carry `dom = '*'` and the matcher honours it —
 * `(p.dom == '*' || r.dom == p.dom)` — but the implicit API filters by exact
 * domain and knows nothing of the custom matcher. Asked for a `tenant_admin`'s
 * permissions it answers **zero**, and a permission set built on that would deny
 * everything. `getImplicitRolesForUser` IS trustworthy: it resolves role chains
 * and honours the domain matcher registered for `g`.
 *
 * So the set is built from the matcher's own terms, and
 * `permission-set-matches-enforce.test.ts` holds it to `enforce()` across the
 * real policy table — the fast path is only allowed to exist while it agrees.
 */
interface EffectivePermissions {
  /** A `('*','*')` rule: everything in this domain, whatever it is called. */
  all: boolean;
  /** `obj\u0000act` pairs. */
  exact: Set<string>;
  /** Objects granted with `act = '*'`. */
  anyAction: Set<string>;
}

const _effective = new Map<string, { perms: EffectivePermissions; expires: number }>();

/** Answer a check from a resolved set — the matcher, minus the scan. */
function allowedBy(perms: EffectivePermissions, resource: string, action: string): boolean {
  if (perms.all) return true;
  if (perms.anyAction.has(resource)) return true;
  return perms.exact.has(`${resource}\u0000${action}`);
}

async function effectivePermissions(userId: string, domain: string): Promise<EffectivePermissions> {
  const key = `${domain}\u0000${userId}`;
  const hit = _effective.get(key);
  if (hit && hit.expires > Date.now()) return hit.perms;

  const gen = _policyGen;
  const e = await getEnforcer();
  // Role chains and the `'*'` domain grant, resolved by casbin itself.
  const subjects = new Set<string>([userId]);
  for (const role of await e.getImplicitRolesForUser(userId, domain)) subjects.add(role);

  const perms: EffectivePermissions = { all: false, exact: new Set(), anyAction: new Set() };
  for (const rule of await e.getPolicy()) {
    const [ps, pd, po, pa] = rule;
    if (ps === undefined || po === undefined || pa === undefined) continue;
    if (!subjects.has(ps)) continue;
    if (pd !== '*' && pd !== domain) continue;
    if (po === '*') {
      // Only `('*','*')` is a wildcard object in this matcher — `('*', 'read')`
      // matches nothing, and treating it as a grant would invent permissions.
      if (pa === '*') perms.all = true;
      continue;
    }
    if (pa === '*') perms.anyAction.add(po);
    else perms.exact.add(`${po}\u0000${pa}`);
  }

  if (gen !== _policyGen) return perms;
  if (_effective.size >= LOCAL_PERM_MAX) {
    const oldest = _effective.keys().next().value;
    if (oldest !== undefined) _effective.delete(oldest);
  }
  _effective.set(key, { perms, expires: Date.now() + PERMISSION_CACHE_TTL * 1000 });
  return perms;
}

/**
 * Test seam: the answer the resolved set gives, without going near `enforce()`.
 *
 * Exported so `permission-set-matches-enforce.test.ts` can hold the two against
 * each other over the real policy table. A fast authorization path that nobody
 * checks against the slow one is how a permission bug ships.
 */
export async function __allowViaSet(
  userId: string,
  domain: string,
  resource: string,
  action: string,
): Promise<boolean> {
  return allowedBy(await effectivePermissions(userId, domain), resource, action);
}

/** Test seam — how many resolved subjects are held. */
export function __effectivePermissionsSize(): number {
  return _effective.size;
}

export function __localPermissionCacheSize(): number {
  return _localPerm.size;
}

/**
 * In-process god flag, and the reason it exists is a connection, not a query.
 *
 * `isGodUser` is called from inside `checkPermission`, which runs on nearly every
 * authenticated request — and it reads `_db`, the POOL, while the request is
 * already holding its tenant transaction. That is a second connection per
 * request. At `c = DB_POOL_MAX` every connection is held by a transaction whose
 * owner is waiting for a second that can never arrive, which is why the instance
 * stops rather than slows at exactly that number. Measured: with DB_POOL_MAX=1 a
 * single `/api/webhooks` request never answers; with 2 it answers in 62 ms.
 *
 * The Valkey cache above already prevented this — for installs that run Valkey.
 * Self-hosted installs mostly do not, and they are the target deployment, so the
 * hot path went to the database every time.
 *
 * TTL is deliberately much shorter than the 300 s remote one: `invalidateGodCache`
 * DELs a shared key for every instance at once, while this map can only be
 * cleared on the instance that ran the change. Five seconds bounds how long a
 * demoted god keeps power on a sibling instance; the remote cache keeps its own
 * five minutes because DEL reaches it.
 */
const LOCAL_GOD_TTL_MS = 5_000;
const _localGod = new Map<string, { value: boolean; at: number }>();

/**
 * The same, for a user's role.
 *
 * `resolveUserRole` has the identical shape and the identical problem:
 * Valkey-backed, and on an install without Valkey — which is the target
 * deployment — it reads the POOL. On the WRITE path that is a second connection
 * per write, measured, because the write pipeline asks for the role after the
 * request already holds its transaction.
 *
 * Same five seconds as the god flag, for the same reason: a `DEL` reaches every
 * instance, this map only the one that ran the change.
 */
const _localRole = new Map<string, { value: string; at: number }>();

/** Test seam — how many god flags are held in process. */
export function __localGodCacheSize(): number {
  return _localGod.size;
}

export function clearLocalPermissionCache(userId?: string): void {
  _policyGen++;
  if (!userId) {
    _localPerm.clear();
    _effective.clear();
    _localGod.clear();
    _localRole.clear();
    invalidatePolicyObjectIndex();
    return;
  }
  _localGod.delete(userId);
  _localRole.delete(userId);
  // Key shape: `perm:${namespace}:${domain}:${userId}:${resource}:${action}`
  const needle = `:${userId}:`;
  for (const key of _localPerm.keys()) {
    if (key.includes(needle)) _localPerm.delete(key);
  }
  for (const key of _effective.keys()) {
    if (key.endsWith(`\u0000${userId}`)) _effective.delete(key);
  }
}
const ROLE_CACHE_TTL = 300; // seconds
const GOD_CACHE_TTL = 300; // seconds

// RBAC with domains (tenants). `dom` is the tenant id, or '*' for a policy/grant
// that applies in EVERY tenant (how all pre-existing global policies are migrated
// — see migration 008 — so authorization is unchanged until per-tenant policies
// are added). A `g` domain-matching function (initPermissions) makes '*' wildcard.
//
// Deny by default: what is not explicitly permitted is forbidden.
//
// `*` on the OBJECT is honoured only when the grant is TOTAL — when the action is
// `*` as well. Read the two aloud and the difference is obvious. "May do anything
// here" is a role: an owner, a tenant administrator, and it keeps working exactly
// as before. "May read anything" is not a decision anyone made about any
// particular resource; it is the absence of one, and it now grants nothing.
//
// That second form is how `tenant_member` was seeded, and it made every
// `permissionGate(ctx, '<resource>')` in twenty-three extensions inert — the
// wildcard answered yes before the resource name was ever considered. An audit
// drove it end to end: an ordinary member read a colleague's national ID, IBAN,
// salary and home address, and could edit them. The negative control was DELETE,
// which `tenant_member` does not hold and which correctly returned 403 — the
// guard did run, and could refuse. Only the policy's width decided the answer.
//
// The seeded partial wildcards are expanded into explicit per-resource rows by
// migration 034, and new resources get theirs from `materializeDefaultGrants`, so
// an upgrade changes who can reach what only where nobody had decided it.
// Afterwards every answer this enforcer gives traces to a row an operator can
// read, revoke, and audit — which a wildcard never was.
const CASBIN_MODEL = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && (p.dom == '*' || r.dom == p.dom) && (r.obj == p.obj || (p.obj == '*' && p.act == '*')) && (r.act == p.act || p.act == '*')
`;

let _db: Database;
let _enforcer: Enforcer | null = null;

class KyselyCasbinAdapter {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  async loadPolicy(model: any): Promise<void> {
    // No cache clear here: this only ever loads an enforcer nobody reads yet
    // (`buildEnforcer`), and the swap that installs it clears after itself.
    const policies = await sql<{
      ptype: string;
      v0: string | null;
      v1: string | null;
      v2: string | null;
      v3: string | null;
      v4: string | null;
      v5: string | null;
    }>`
      SELECT ptype, v0, v1, v2, v3, v4, v5
      FROM zvd_permissions
    `.execute(_db);

    for (const line of policies.rows) {
      const tokens = [line.ptype, line.v0, line.v1, line.v2, line.v3, line.v4, line.v5].filter(
        (v): v is string => v !== null,
      );
      // Helper.loadPolicyLine is the canonical adapter load path. The previous
      // `model.addPolicy(tokens)` called Model.addPolicy(sec, key, rule) with a
      // single array — it returned false and loaded NOTHING, so every policy in
      // zvd_permissions was silently ignored at boot and runtime grants only
      // lived until the next restart (deny-by-default afterwards).
      Helper.loadPolicyLine(tokens.join(', '), model);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  async savePolicy(model: any): Promise<boolean> {
    // Wrap TRUNCATE + INSERT in a single transaction so there's never a
    // window where zvd_permissions is empty. A crash in the middle would
    // otherwise wipe every Casbin policy and lock out all non-god users.
    // TRUNCATE is transactional in PostgreSQL and rolls back on failure.
    // Collect BOTH policy sections. The previous `model.getPolicy()` called
    // Model.getPolicy(sec, key) with no arguments — it returned nothing, so
    // savePolicy would TRUNCATE the table and re-insert zero rows, wiping every
    // policy AND role grant (the old loop also never read the 'g' section).
    const lines: string[][] = [];
    for (const section of ['p', 'g'] as const) {
      const astMap = model.model.get(section);
      if (!astMap) continue;
      for (const [ptype, ast] of astMap) {
        for (const rule of ast.policy) {
          lines.push([ptype, ...rule]);
        }
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    await (_db as any).transaction().execute(async (trx: Database) => {
      await sql`TRUNCATE TABLE zvd_permissions`.execute(trx);
      for (const [ptype, ...values] of lines) {
        await sql`
          INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3, v4, v5)
          VALUES (${ptype}, ${values[0] ?? null}, ${values[1] ?? null}, ${values[2] ?? null},
                  ${values[3] ?? null}, ${values[4] ?? null}, ${values[5] ?? null})
        `.execute(trx);
      }
    });
    return true;
  }

  async addPolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    // Every policy write reaches the database through this adapter, whichever
    // route or boot task called it — so this is the one place where dropping the
    // memo and the object index catches all of them.
    clearLocalPermissionCache();
    invalidatePolicyObjectIndex();
    await trackPolicyWrite(() =>
      sql`
        INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3, v4, v5)
        VALUES (${ptype}, ${rule[0] ?? null}, ${rule[1] ?? null}, ${rule[2] ?? null},
                ${rule[3] ?? null}, ${rule[4] ?? null}, ${rule[5] ?? null})
      `.execute(_db),
    );
  }

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    clearLocalPermissionCache();
    invalidatePolicyObjectIndex();
    // An absent column is matched with IS NULL, not `= NULL`.
    //
    // This used to compare v0..v3 unconditionally, which is right for a `p`
    // rule (sub, dom, obj, act — four values) and wrong for every `g` rule,
    // which carries three. The fourth comparison became `v3 = NULL`, and in SQL
    // that is never true, so the DELETE removed nothing at all.
    //
    // Casbin removes the rule from the in-memory model either way, so
    // revocation LOOKED like it worked and kept working until the next policy
    // load. Measured against the real table:
    //
    //   granted owner        → table: tenant_owner
    //   demoted to member    → table: tenant_member, tenant_owner
    //     in memory now: owner=false member=true
    //   after a restart      → owner=true  member=true
    //
    // Three routes revoke this way: removing a member from a tenant, changing a
    // member's role (which deletes every prior grant before adding the new one),
    // and removing a role-inheritance edge. The effect rule is `some(allow)`, so
    // once the old row comes back the widest grant wins and the demotion is
    // undone.
    const conditions = [sql`ptype = ${ptype}`];
    for (let i = 0; i < 6; i++) {
      const column = sql.ref(`v${i}`);
      const value = rule[i];
      conditions.push(value === undefined ? sql`${column} IS NULL` : sql`${column} = ${value}`);
    }
    await trackPolicyWrite(() =>
      sql`DELETE FROM zvd_permissions WHERE ${sql.join(conditions, sql` AND `)}`.execute(_db),
    );
  }

  async removeFilteredPolicy(
    _sec: string,
    ptype: string,
    fieldIndex: number,
    ...fieldValues: (string | undefined)[]
  ): Promise<void> {
    clearLocalPermissionCache();
    invalidatePolicyObjectIndex();
    // `fieldIndex` says which column the first value belongs to.
    //
    // It used to be ignored — the parameter was even named `_fieldIndex` — and
    // the values were pinned to v0, v1, v2, v3 whatever the caller meant. Casbin
    // uses this to ask questions like "every `g` rule whose SECOND column is this
    // role", which is how a role is taken away from everyone holding it. Asked
    // that way, this deleted `WHERE v0 = <role>` instead, which normally matches
    // nothing.
    //
    // The model updates either way, so the removal looked like it worked.
    // Measured, `removeFilteredGroupingPolicy(1, role)` on a live table:
    //
    //   before                      table: user→role   memory: ["role"]
    //   after                       table: user→role   memory: []
    //
    // Same shape as the `= NULL` comparison in `removePolicy`: right in memory,
    // untouched in the database, and back after the next policy load.
    //
    // An empty string is casbin's "any value in this column", so it is skipped
    // exactly like an absent one.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const conditions: any[] = [sql`ptype = ${ptype}`];
    fieldValues.forEach((value, offset) => {
      const column = fieldIndex + offset;
      if (value === undefined || value === '' || column < 0 || column > 5) return;
      conditions.push(sql`${sql.ref(`v${column}`)} = ${value}`);
    });

    await trackPolicyWrite(() =>
      sql`DELETE FROM zvd_permissions WHERE ${sql.join(conditions, sql` AND `)}`.execute(_db),
    );
  }
}

/**
 * A complete enforcer loaded from the table — built off to the side, never by
 * reloading the live one (see `casbin-reload-window.test.ts`).
 */
async function buildEnforcer(): Promise<Enforcer> {
  const e = await newEnforcer(newModelFromString(CASBIN_MODEL), new KyselyCasbinAdapter());
  // Make '*' a wildcard domain in role grants (g): a grant `(user, role, '*')`
  // then applies in every tenant. Validated against casbin 5.x.
  await e.addNamedDomainMatchingFunc('g', (r: string, p: string) => p === '*' || r === p);
  // Every enforcer write (admin routes, role grants, tenant membership) tells
  // the other instances — see `publishPolicyChange`.
  e.setWatcherEx(policyWatcherFor(e));
  return e;
}

export async function initPermissions(db: Database): Promise<void> {
  _db = db;
  // Read before the load, so a write landing in between makes the next
  // reconcile rebuild rather than trust a state that never held it.
  const fingerprint = await policyFingerprint();
  _enforcer = await buildEnforcer();
  _appliedFingerprint = fingerprint;
  clearLocalPermissionCache();

  // HMAC signing for the permission & god-role caches is keyed on BETTER_AUTH_SECRET.
  // An empty/missing secret makes the HMAC trivially forgeable — an attacker who can write
  // to Redis could craft a valid signed value and escalate privileges.
  // Fail-closed: throw at startup rather than running insecurely.
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error(
      '[permissions] FATAL: BETTER_AUTH_SECRET env var is not set. ' +
        'Permission cache HMAC signatures would use an empty secret, making privilege escalation trivial. ' +
        'Set BETTER_AUTH_SECRET to a strong random value before starting the engine.',
    );
  }
}

/**
 * Resources that do not receive a default grant when they come into existence.
 *
 * Under deny-by-default (see the matcher) every resource starts closed, and
 * `materializeDefaultGrants` opens the ordinary business ones for the standard
 * roles so that installing an extension or creating a collection does not
 * require an administrator to go and click something before anyone can work.
 * The names below are excluded from that convenience: they stay closed until a
 * role is granted them explicitly, by name.
 *
 * The distinction is between data a colleague may see because you work together
 * and data an employer holds because the law says it must.
 */
const SENSITIVE_RESOURCES = new Set<string>([
  // Personal data an employer holds because it must, not because colleagues
  // should read it: national ID, bank account, salary, home address.
  'employees',
  'payroll',
  'leave',
  // Company banking. The same argument, one level up.
  'banking',
  // Added by owner decision (2026-08-07) after an audit measured what an
  // ordinary member could actually reach. Expense reports carry amounts,
  // merchants and receipts per person — where somebody was and who with — and
  // time tracking is attendance. Both are closer to `leave`, already here, than
  // to `crm`.
  'expenses',
  'time-tracking',
  // The company's books and its invoices. The widest part of the decision and
  // the one worth stating plainly: in many companies invoicing is daily work
  // for ordinary staff, so this WILL take access away from people who had it.
  // That is the intent — an operator grants the roles that need it by name,
  // once, rather than everyone holding it because nobody chose.
  'accounting',
  'invoices',
]);

/** Extensions may add their own; see `registerSensitiveResources`. */
export function registerSensitiveResources(resources: readonly string[]): void {
  for (const r of resources) {
    const name = r.trim();
    if (name) SENSITIVE_RESOURCES.add(name);
  }
}

/** Test seam + introspection for the settings UI. */
export function listSensitiveResources(): string[] {
  return [...SENSITIVE_RESOURCES].sort();
}

/** Whether a resource is withheld from default grants. */
export function isSensitiveResource(name: string): boolean {
  return SENSITIVE_RESOURCES.has(name);
}

export async function getEnforcer(): Promise<Enforcer> {
  if (!_enforcer) throw new Error('Permissions not initialized. Call initPermissions() first.');
  return _enforcer;
}

/**
 * HMAC helpers shared by god-role cache and permission result cache.
 * Both caches sign their values with HMAC-SHA256 (keyed on BETTER_AUTH_SECRET)
 * to prevent privilege escalation via direct Redis key manipulation.
 */
function _permHmac(key: string, value: '1' | '0'): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error(
      '[permissions] BETTER_AUTH_SECRET is not set — cannot sign permission cache entry',
    );
  return createHmac('sha256', secret).update(`perm:${key}:${value}`).digest('hex');
}

function _encodePermCache(key: string, allowed: boolean): string {
  const value = allowed ? '1' : '0';
  return `${value}:${_permHmac(key, value)}`;
}

/** Returns `true/false` if HMAC valid, `null` if tampered. */
function _decodePermCache(key: string, raw: string): boolean | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const value = raw.slice(0, sep);
  const storedHmac = raw.slice(sep + 1);
  if (value !== '1' && value !== '0') return null;
  try {
    const expected = Buffer.from(_permHmac(key, value as '1' | '0'), 'hex');
    const stored = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
  } catch {
    return null;
  }
  return value === '1';
}

/**
 * HMAC helpers for the god-role cache.
 *
 * Threat model: an attacker who can write arbitrary keys into Valkey could
 * set `god:{userId}` to `'1'` and bypass all authorization.  Signing the
 * cached value with HMAC-SHA256 (keyed on BETTER_AUTH_SECRET) makes the
 * value unforgeable without knowledge of the application secret.
 *
 * Format stored in cache: `${value}:${hmac}` e.g. `1:a3f9...`
 * If HMAC verification fails, we return `null` → DB fallback (fail-closed).
 */
function _godHmac(userId: string, value: '1' | '0'): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error(
      '[permissions] BETTER_AUTH_SECRET is not set — cannot sign god-role cache entry',
    );
  return createHmac('sha256', secret).update(`god:${userId}:${value}`).digest('hex');
}

function _encodeGodCache(userId: string, isGod: boolean): string {
  const value = isGod ? '1' : '0';
  return `${value}:${_godHmac(userId, value)}`;
}

/** Returns `true/false` if HMAC is valid, `null` if tampered / invalid format. */
function _decodeGodCache(userId: string, raw: string): boolean | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const value = raw.slice(0, sep);
  const storedHmac = raw.slice(sep + 1);
  if (value !== '1' && value !== '0') return null;
  try {
    const expected = Buffer.from(_godHmac(userId, value as '1' | '0'), 'hex');
    const stored = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
  } catch {
    return null;
  }
  return value === '1';
}

/**
 * Checks if a user has the "god" role — directly from DB, independent of Casbin.
 * Cached for performance. Fail-closed: returns false if DB is unavailable.
 * Cache values are HMAC-signed to prevent Valkey-injection privilege escalation.
 */
/**
 * The role to evaluate this request as — read from the database, not the
 * session.
 *
 * `session.user.role` is always undefined: `role` is not declared in
 * better-auth's `additionalFields`. `lib/data/auth.ts` already says the field
 * is unreliable and routes authorization through `checkPermission()` for that
 * reason — but every column-permission and expand call site kept reading it,
 * falling back to `'public'`. So a rule written for a NAMED role matched
 * nobody (the column it should have hidden stayed visible), while an
 * administrator missed getColumnAccess's admin short-circuit and could be
 * blinded by a `public` rule. Both directions wrong, from one undefined field.
 *
 * An explicitly-set role wins: the API-key pseudo-user carries `role:
 * 'api_key'`, which is constructed rather than read from a session and must not
 * be overwritten by a lookup that would find nothing.
 *
 * Cached like `isGodUser`, HMAC-signed so a writable cache cannot promote a
 * member. When the database cannot answer, it THROWS.
 *
 * It used to answer `'public'` as "the least-privileged role", but there is no
 * such role here: column rules and row rules are restrictions keyed BY role, so
 * a rule written for `member` hides a column from members and from nobody
 * else. A member read as `public` escaped every `member` rule — the fallback
 * opened exactly what it was meant to close. `isGodUser` can fail to `false`
 * because god is a grant; a role is not, so a caller that cannot learn it
 * must refuse, the way the REST data path already does on any lookup error.
 */
export async function resolveUserRole(user: { id?: string; role?: string }): Promise<string> {
  if (user.role) return user.role;
  const userId = user.id;
  if (!userId || userId.startsWith('apikey:')) return 'public';

  const local = _localRole.get(userId);
  if (local && Date.now() - local.at < LOCAL_GOD_TTL_MS) return local.value;

  const cache = getCache();
  const cacheKey = `urole:${userId}`;
  if (cache) {
    try {
      const raw = await cache.get(cacheKey);
      if (raw !== null) {
        const decoded = _decodeRolesCache(cacheKey, userId, raw);
        if (decoded !== null && decoded.length === 1) return decoded[0]!;
      }
    } catch {
      /* cache unavailable */
    }
  }

  // Deliberately NOT savepoint-guarded, and that is measured rather than assumed.
  //
  // `_db` is the pool handle, not the request's transaction, so `SAVEPOINT`
  // answers `25P01 SAVEPOINT can only be used in transaction blocks`. A version
  // of this change wrapped it anyway: CI then showed thirteen consecutive 25P01s
  // followed by a `25P02` on an unrelated request — the guard had become the
  // thing it was added to prevent. See lib/savepoint.ts.
  //
  // Not caught either: see the doc comment — there is no role to fall back to.
  const result = await sql<{ role: string }>`
    SELECT role FROM "user" WHERE id = ${userId} LIMIT 1
  `.execute(_db);
  const role = result.rows[0]?.role || 'public';
  _localRole.set(userId, { value: role, at: Date.now() });
  if (cache) {
    try {
      await cache.setex(cacheKey, GOD_CACHE_TTL, _encodeRolesCache(cacheKey, userId, [role]));
    } catch {
      /* cache unavailable */
    }
  }
  return role;
}

export async function isGodUser(userId: string): Promise<boolean> {
  try {
    return await lookupGod(userId);
  } catch {
    return false; // Fail closed — if DB is down, do NOT grant god access
  }
}

/** `isGodUser` without the fallback: a failed database read throws. */
async function lookupGod(userId: string): Promise<boolean> {
  // Checked before the remote cache: the point is to touch neither the pool nor
  // the network while a request holds its tenant transaction.
  const local = _localGod.get(userId);
  if (local && Date.now() - local.at < LOCAL_GOD_TTL_MS) return local.value;

  const cache = getCache();
  const cacheKey = `god:${userId}`;

  if (cache) {
    try {
      // GET — O(1): single key lookup by exact name, no scan.
      const raw = await cache.get(cacheKey);
      if (raw !== null) {
        const decoded = _decodeGodCache(userId, raw);
        // null = HMAC mismatch → fall through to DB (do not trust cached value)
        if (decoded !== null) {
          _localGod.set(userId, { value: decoded, at: Date.now() });
          return decoded;
        }
      }
    } catch {
      /* cache unavailable */
    }
  }

  // Deliberately NOT savepoint-guarded, and that is measured rather than assumed.
  //
  // `_db` is the pool handle, not the request's transaction, so `SAVEPOINT`
  // answers `25P01 SAVEPOINT can only be used in transaction blocks`. A version
  // of this change wrapped it anyway: CI then showed thirteen consecutive 25P01s
  // followed by a `25P02` on an unrelated request — the guard had become the
  // thing it was added to prevent. See lib/savepoint.ts.
  const result = await sql<{ role: string }>`
    SELECT role FROM "user" WHERE id = ${userId} LIMIT 1
  `.execute(_db);

  const isGod = result.rows[0]?.role === 'god';
  _localGod.set(userId, { value: isGod, at: Date.now() });

  if (cache) {
    try {
      // SETEX — O(1): write HMAC-signed value + TTL on a single known key.
      await cache.setex(cacheKey, GOD_CACHE_TTL, _encodeGodCache(userId, isGod));
    } catch {
      /* cache unavailable */
    }
  }

  return isGod;
}

/**
 * Invalidates the god-role cache for a user (call when user role changes).
 *
 * Complexity breakdown:
 *   DEL god:{userId}  — O(1): deletes exactly one key by its full name.
 *                       No keyspace scan is performed. KEYS-based alternatives
 *                       would be O(N) over the total number of keys in Valkey,
 *                       blocking the server during the scan.
 */
export async function invalidateGodCache(userId: string): Promise<void> {
  clearLocalPermissionCache(userId);
  const cache = getCache();
  if (!cache) return;
  try {
    // BOTH keys, because both cache the same fact under different names.
    //
    // `god:<id>` answers "is this user god"; `urole:<id>` answers "what is this
    // user's role", and `resolveUserRole` reads it. Only the first was dropped,
    // so the second kept saying `god` for the rest of its 300 s TTL. Measured
    // against a live Valkey, demoting a god and then invalidating:
    //
    //   cached           → god:=set     urole:=["god"]
    //   after invalidate → god:=absent  urole:=["god"]
    //   resolveUserRole  → god
    //
    // That is not a stale display. `routes/rpc.ts` passes `resolveUserRole`
    // straight into `userHasRole`, which returns true unconditionally for
    // `'god'` — so the demoted holder keeps a full RPC bypass for five minutes.
    // The one caller of this function is the recovery flow, whose entire premise
    // is that the previous holder has lost control.
    //
    // The in-process copies were already cleared above; Valkey is shared, so
    // leaving it behind affects every instance including this one, which reads
    // the shared value the moment its own 5 s memo lapses.
    await cache.del(`god:${userId}`, `urole:${userId}`);
  } catch {
    /* cache unavailable */
  }
}

export async function checkPermission(
  userId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  // ═══ HARDCODED GOD BYPASS ═══
  // Independent of Casbin — even if ALL policies are deleted,
  // a user with role='god' will ALWAYS have full access.
  const gen = _policyGen;
  let godLookupError: unknown;
  try {
    if (await lookupGod(userId)) return true;
  } catch (err) {
    godLookupError = err ?? new Error('god lookup failed');
  }
  const allowed = await casbinAllows(userId, resource, action, gen);
  // A failed god lookup is not "not god". A grant Casbin holds decides alone;
  // a refusal cannot be told apart from an unreadable god flag, so it THROWS.
  // Still a refusal to every request-path caller (none reads a throw as yes),
  // while the realtime sweeps read it as "retry", not as a revoke that ends a
  // god's streams on a database blip.
  if (allowed || godLookupError === undefined) return allowed;
  // 503 + Retry-After, not a bare 500: the caller is told the check is
  // temporarily impossible and can retry, rather than that it was refused.
  const err = problem(
    'permission.unavailable',
    503,
    `Permission for  on "" cannot be checked right now; retry shortly.`,
  );
  err.retryAfter = 5;
  err.cause = godLookupError;
  throw err;
}

/** The Casbin half of `checkPermission`: memo, shared cache, resolved set. */
async function casbinAllows(
  userId: string,
  resource: string,
  action: string,
  gen: number,
): Promise<boolean> {
  const domain = getCurrentDomain();
  const cache = getCache();
  // A name no policy mentions cannot change the answer — see `policyObjectIndex`.
  // Filing every such name under one key is what stops an invented-name flood
  // from costing one full `enforce()` each.
  const named = (await policyObjectIndex()).has(resource) ? resource : UNKNOWN_RESOURCE;
  const cacheKey = `perm:${cacheNamespace()}:${domain}:${userId}:${named}:${action}`;

  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        // Verify HMAC signature — null means tampered, fall through to DB
        const decoded = _decodePermCache(cacheKey, cached);
        if (decoded !== null) return decoded;
      }
    } catch {
      /* cache unavailable */
    }
  } else {
    // No shared cache — see the note on `_localPerm`. No HMAC here: the value
    // never leaves this process, so there is nothing to tamper with in transit.
    const local = localPermGet(cacheKey);
    if (local !== null) return local;
  }

  // Resolved once per (user, domain), then answered by lookup — see
  // `effectivePermissions`. `enforce()` stops at the first matching policy, so a
  // granted question was already cheap; it was the DENIALS that read all 7 208
  // rules to conclude nothing applied, at 364-885 ms each. Those are the answers
  // an attacker asks for, and now they cost a Set miss.
  const result = allowedBy(await effectivePermissions(userId, domain), resource, action);
  // Computed across a policy change: right for this request, not for the next.
  if (gen !== _policyGen) return result;

  if (cache) {
    try {
      // Store HMAC-signed value — prevents privilege escalation via Redis writes.
      // Not tracked per user: a change bumps the namespace, so this key is never
      // read again after one and dies by TTL — see `invalidateUserPermCache`.
      await cache.setex(cacheKey, PERMISSION_CACHE_TTL, _encodePermCache(cacheKey, result));
    } catch {
      /* cache unavailable */
    }
  } else {
    localPermSet(cacheKey, result);
  }

  return result;
}

/**
 * Instance-level admin gate for whole-instance power tools (raw SQL, code
 * deploy, role grants, RLS/DDL, extension install, global settings).
 *
 * `checkPermission(uid, 'admin', '*')` alone is NOT sufficient here: the
 * `tenant_owner`/`tenant_admin` Casbin policies grant `('*','*','*')` inside a
 * tenant's domain, so `obj='admin'` matches and a delegated tenant admin would
 * pass — then reach a global-pool SQL editor and `UPDATE "user" SET role='god'`.
 * Require the admin grant AND that it comes from the ROOT tenant domain (the
 * single-tenant default, where admin == instance owner) OR the god role. In
 * single-tenant deployments the domain is always the root, so this is a no-op.
 */
export async function requireInstanceAdmin(userId: string): Promise<boolean> {
  if (await isGodUser(userId)) return true;
  // `getCurrentDomainOrNull`, not `getCurrentDomain`: the latter answers
  // DEFAULT_TENANT_ID when no store was ever opened, so a request whose tenant
  // could not be resolved read as "we are in the root tenant" and a delegated
  // tenant_admin passed this gate. No context is not the root tenant.
  const domain = getCurrentDomainOrNull();
  if (domain !== DEFAULT_TENANT_ID) return false;
  return checkPermission(userId, 'admin', '*');
}

/**
 * Admin gate for TENANT-SCOPED resources — media, drafts, documents, revisions,
 * saved queries and the like, where "admin" should mean "administers the tenant
 * this request belongs to".
 *
 * A delegated `tenant_admin` passes, and that is the intended behaviour: the row
 * is already confined to their tenant by RLS, so letting them override a
 * per-record ownership check inside it is what an administrator is for.
 *
 * This is exactly what `checkPermission(uid, 'admin', '*')` already did. The
 * point of the named helper is that the bare call meant two different things at
 * different call sites — an instance-wide gate at some, a tenant-scoped override
 * at others — and nothing distinguished them. That ambiguity is why a whole
 * class of routes was gated by a check that a tenant admin passes, and why the
 * obvious "sweep them all to requireInstanceAdmin" fix would have broken
 * multi-tenancy instead. Every call site now has to say which one it means, and
 * scripts/admin-gate-check.ts fails the build if the bare form comes back.
 */
export async function isTenantAdmin(userId: string): Promise<boolean> {
  return checkPermission(userId, 'admin', '*');
}

/**
 * HMAC helpers for the roles cache.
 *
 * Threat model: an attacker with Redis write access could inject a crafted
 * roles list (e.g. '["admin"]') at key `roles:{userId}`, causing Casbin to
 * believe the user has elevated roles.  Signing with HMAC-SHA256 prevents
 * this — any tampered value will fail verification and fall through to DB.
 *
 * Format stored in cache: `${rolesJson}:${hmac64hexChars}`
 * SHA-256 hex is always exactly 64 characters, so the last 65 bytes
 * (`:` + 64 hex) are unambiguous regardless of the JSON content.
 */
function _rolesHmac(cacheKey: string, userId: string, rolesJson: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error('[permissions] BETTER_AUTH_SECRET is not set — cannot sign roles cache entry');
  // The KEY is signed, not just the user and the value.
  //
  // These entries live under two different keys — `roles:<domain>:<user>` and
  // `urole:<user>` — and the signature used to cover only the user and the JSON.
  // So a value this engine wrote for one key verified under any other: an
  // attacker with cache write access, which is the threat these HMACs exist for,
  // could copy a user's `roles:<tenantA>:<user>` entry to
  // `roles:<tenantB>:<user>` and the copy would pass verification, carrying
  // their tenant-A roles into tenant B. The user id is bound, so this never
  // crossed between people — it crossed between tenants, which is the boundary
  // the product is built on.
  //
  // `_permHmac`, forty lines up, signs its full key already. This is the same
  // decision, made the same way, in the function that spans domains.
  return createHmac('sha256', secret)
    .update(`roles:${cacheKey}:${userId}:${rolesJson}`)
    .digest('hex');
}

function _encodeRolesCache(cacheKey: string, userId: string, roles: string[]): string {
  const json = JSON.stringify(roles);
  return `${json}:${_rolesHmac(cacheKey, userId, json)}`;
}

/** Returns the roles array if HMAC is valid, `null` if tampered / malformed. */
function _decodeRolesCache(cacheKey: string, userId: string, raw: string): string[] | null {
  // HMAC is always 64 hex chars; separator is ':'
  const HMAC_LEN = 64;
  if (raw.length < HMAC_LEN + 2) return null; // at minimum '[]' + ':' + 64 chars
  const storedHmac = raw.slice(raw.length - HMAC_LEN);
  const json = raw.slice(0, raw.length - HMAC_LEN - 1); // strip ':' + hmac
  try {
    const expected = Buffer.from(_rolesHmac(cacheKey, userId, json), 'hex');
    const stored = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Return every role known to the Casbin enforcer (the union of all role
 * names assigned to any user). Used by routes that need to validate a
 * caller-supplied role name (e.g. dashboard sharing) before persisting
 * it, so we don't store dead references to roles that don't exist.
 */
export async function listAllRoles(): Promise<string[]> {
  const e = await getEnforcer();
  // ptype='g' grouping policies — each row is [user, role]. Take the
  // second column as the role set.
  const policies: string[][] = (await e.getNamedGroupingPolicy('g')) ?? [];
  const set = new Set<string>();
  for (const row of policies) {
    if (row.length >= 2 && row[1]) set.add(row[1]);
  }
  return [...set];
}

export async function getUserRoles(userId: string): Promise<string[]> {
  const domain = getCurrentDomain();
  const cache = getCache();
  const gen = _policyGen;
  const cacheKey = `roles:${cacheNamespace()}:${domain}:${userId}`;

  if (cache) {
    try {
      // GET — O(1): direct key lookup.
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        // Verify HMAC — null means tampered, fall through to DB (fail-closed)
        const decoded = _decodeRolesCache(cacheKey, userId, cached);
        if (decoded !== null) return decoded;
      }
    } catch {
      /* cache unavailable */
    }
  }

  const e = await getEnforcer();
  // Roles the user holds in this domain. Casbin's getRolesForUser(user, domain)
  // honours the '*' domain-matching func, so global grants are included.
  const roles = await e.getRolesForUser(userId, domain);

  // Same rule as `checkPermission`: never file an answer computed across a change.
  if (cache && gen === _policyGen) {
    try {
      // SETEX — O(1): HMAC-signed roles under a namespaced key, untracked like
      // the permission answers.
      await cache.setex(cacheKey, ROLE_CACHE_TTL, _encodeRolesCache(cacheKey, userId, roles));
    } catch {
      /* cache unavailable */
    }
  }

  return roles;
}

/**
 * Invalidates all permission and role cache entries for a single user.
 *
 * The permission and role answers need no DEL: `clearLocalPermissionCache`
 * bumps this instance's namespace, so none of its old keys is read again, and
 * another instance's keys answer from its own model, which only its own bump
 * (bus or reconcile) moves. They used to be tracked in `user:perm-keys:<id>`
 * and deleted here, but every change left the set holding dead-namespace keys
 * and every write refreshed its TTL, so it grew for as long as the user stayed
 * active. `god:` and `urole:` are not namespaced — they cache the "user" row,
 * not the model — and are deleted by name. The set itself is deleted in case a
 * version that still wrote it left one behind.
 */
export async function invalidateUserPermCache(userId: string): Promise<void> {
  clearLocalPermissionCache(userId);
  const cache = getCache();
  if (cache) {
    try {
      await cache.del(`god:${userId}`, `urole:${userId}`, `user:perm-keys:${userId}`);
    } catch {
      /* cache unavailable */
    }
  }
  // The query cache holds rows already RLS-filtered + column-masked for this
  // user's role — a role grant/revoke must drop them too, or the change is
  // served stale for up to the TTL.
  const { invalidateUserQueryCache } = await import('../data/index.js');
  await invalidateUserQueryCache(userId);
  // The bump above already voids every socket's cached subscribe decision; open
  // subscriptions are re-checked too, so a revoke stops the stream.
  revalidateSockets();
}

let _sweep: Promise<void> | null = null;
let _sweepAgain = false;
let _sweepRetry: ReturnType<typeof setTimeout> | null = null;
/** First retry after a failed sweep; doubles per consecutive failure, capped. */
const SWEEP_RETRY_MS = 5_000;
const SWEEP_RETRY_MAX_MS = 60_000;
let _sweepRetryMs = SWEEP_RETRY_MS;

/**
 * Re-check every open realtime subscription — WebSocket and SSE — against the
 * policy as it now is. Only after the change is applied, never from the adapter
 * (which runs before the model moves). One sweep at a time; a change during a
 * sweep runs one more. Dynamic imports avoid a tenancy → routes cycle.
 *
 * Each door keeps a subscription whose re-check threw (a lookup error is not a
 * revoke) and says so; then one retry sweep is scheduled, for both doors, so a
 * revoke still lands once lookups recover.
 */
/** Test seam: settles once no realtime sweep is running. */
export function __sweepIdle(): Promise<void> {
  return _sweep ?? Promise.resolve();
}

export function revalidateSockets(): void {
  if (_sweep) {
    _sweepAgain = true;
    return;
  }
  _sweep = (async () => {
    let failed = false;
    do {
      _sweepAgain = false;
      failed = await Promise.all([
        import('../../routes/ws.js').then((m) => m.revalidateWsSubscriptions()),
        import('../../routes/realtime.js').then((m) => m.revalidateSseStreams()),
      ]).then(
        (doors) => doors.includes(true),
        () => false, // a routes module unavailable in some unit-test graphs
      );
    } while (_sweepAgain);
    // An outage that outlasts one retry is not hammered every five seconds for
    // its whole length: each consecutive failure doubles the wait, up to a
    // minute, and a clean sweep resets it.
    if (!failed) _sweepRetryMs = SWEEP_RETRY_MS;
    else if (!_sweepRetry) {
      const delay = _sweepRetryMs;
      _sweepRetryMs = Math.min(delay * 2, SWEEP_RETRY_MAX_MS);
      _sweepRetry = setTimeout(() => {
        _sweepRetry = null;
        revalidateSockets();
      }, delay);
      _sweepRetry.unref?.();
    }
  })().finally(() => {
    _sweep = null;
  });
}

/**
 * `revalidateSockets`, here and on every other instance: for a row rule or
 * column permission change, which lives in the table and the shared cache but
 * in each instance's open subscriptions too. Call once the change is committed
 * and the shared caches are dropped — a receiver re-resolves from them at once.
 */
export function revalidateSocketsEverywhere(): void {
  revalidateSockets();
  realtimeBus()
    .publish({
      event: ACCESS_RULES_CHANGED_EVENT,
      collection: '',
      timestamp: new Date().toISOString(),
    })
    .catch((err: Error) => {
      console.error('[permissions] could not publish a rule change:', err.message);
    });
}

/**
 * Drop every cached permission answer after a policy change whose reach is not
 * one user, and re-check the WebSocket subscriptions it may have revoked.
 *
 * The bump in `clearLocalPermissionCache` moves this instance to a fresh cache
 * namespace, so the shared copy needs no purge — see `cacheNamespace`.
 * `{ shared: true }` is the operator's manual flush, which also drops the god
 * and role flags a raw SQL edit of "user" leaves behind.
 */
export async function invalidateAllPermissionCaches(opts?: { shared?: boolean }): Promise<void> {
  // First and unconditionally — see `_localPerm`.
  clearLocalPermissionCache();
  revalidateSockets();
  const cache = getCache();
  if (!cache || !opts?.shared) return;
  try {
    const allKeys: string[] = [];
    for (const pattern of ['perm:*', 'roles:*', 'god:*', 'urole:*', 'user:perm-keys:*']) {
      let cursor = '0';
      do {
        const [nextCursor, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        allKeys.push(...batch);
      } while (cursor !== '0');
    }
    if (allKeys.length > 0) await cache.del(...allKeys);
  } catch {
    /* cache unavailable */
  }
}

// ── Cross-instance policy propagation ───────────────────────────────────────
//
// Casbin holds its policies in memory, loaded once at boot. A write reached the
// database and the memory of the instance that ran it, and no other: a revoked
// grant stayed honoured on every other replica until it restarted (the shared
// cache was purged, and the stale replica wrote its stale answer straight back
// into it), and a collection created on one replica answered 403 on the rest.
//
// Each write now goes out on the realtime bus. The message names the rules; it
// does not carry authority. The Valkey channel can be written by anyone who can
// write the cache — the threat every cache HMAC in this file exists for — so the
// receiver re-reads the named rules from `zvd_permissions` and makes its model
// agree with the table. A forged message can therefore only make a replica
// re-read what is already true, and messages may arrive in any order.
//
// Applied incrementally (`selfAddPolicy`/`selfRemovePolicy`: model plus role
// links, no adapter, no re-publish), never `loadPolicy()` — see
// `casbin-reload-window.test.ts` for what a live reload does to requests in flight.
//
// The bus is lossy (a Valkey reconnect, a dropped NOTIFY), so it is only the
// fast path: `reconcilePolicies` compares a fingerprint of the table against the
// state this instance last loaded, on a timer and on every bus reconnect, and
// rebuilds the enforcer from the table when they differ.

interface PolicyChange {
  sec: 'p' | 'g';
  ptype: string;
  /** Concrete rules added or removed. */
  rules?: string[][];
  /** A `removeFilteredPolicy` call, re-evaluated against the receiver's own model. */
  fieldIndex?: number;
  fieldValues?: string[];
}

/** Rules per message — keeps each one far below pg_notify's 8 KB cap. */
const RULES_PER_MESSAGE = 50;
let _publishChain: Promise<void> = Promise.resolve();

/**
 * Tell the other instances that these rules changed. Fire-and-forget, in order:
 * casbin does not await its watcher, and a remove followed by a re-add of the
 * same rule must not be reordered on the way out.
 */
export function publishPolicyChange(change: PolicyChange): void {
  const rules = change.rules ?? [];
  const batches: Array<string[][] | undefined> = [];
  for (let i = 0; i < rules.length; i += RULES_PER_MESSAGE) {
    batches.push(rules.slice(i, i + RULES_PER_MESSAGE));
  }
  if (batches.length === 0) batches.push(undefined);
  for (const batch of batches) {
    const data: PolicyChange = { ...change, rules: batch };
    _publishChain = _publishChain
      .then(() =>
        realtimeBus().publish({
          event: POLICY_CHANGED_EVENT,
          collection: '',
          data,
          timestamp: new Date().toISOString(),
        }),
      )
      .catch((err: Error) => {
        console.error('[permissions] could not publish a policy change:', err.message);
      });
  }
}

function policyWatcherFor(owner: Enforcer) {
  const changed = (change: PolicyChange) => {
    publishPolicyChange(change);
    // A request that fetched the enforcer before a reconcile swapped it wrote to
    // the table and to a model nobody reads any more. The table is right; bring
    // the live enforcer to it now rather than at the next tick.
    if (owner !== _enforcer) void reconcilePolicies();
  };
  return {
    async updateForAddPolicy(sec: string, ptype: string, ...rule: string[]) {
      changed({ sec: sec as 'p' | 'g', ptype, rules: [rule] });
    },
    async updateForRemovePolicy(sec: string, ptype: string, ...rule: string[]) {
      changed({ sec: sec as 'p' | 'g', ptype, rules: [rule] });
    },
    async updateForAddPolicies(sec: string, ptype: string, ...rules: string[][]) {
      changed({ sec: sec as 'p' | 'g', ptype, rules });
    },
    async updateForRemovePolicies(sec: string, ptype: string, ...rules: string[][]) {
      changed({ sec: sec as 'p' | 'g', ptype, rules });
    },
    async updateForRemoveFilteredPolicy(
      sec: string,
      ptype: string,
      fieldIndex: number,
      ...fieldValues: string[]
    ) {
      changed({ sec: sec as 'p' | 'g', ptype, fieldIndex, fieldValues });
    },
    // `savePolicy` rewrites the whole table and nothing calls it at runtime.
    async updateForSavePolicy() {
      return false;
    },
  };
}

function parsePolicyChange(data: unknown): PolicyChange | null {
  if (!data || typeof data !== 'object') return null;
  const c = data as Record<string, unknown>;
  const sec = c.sec;
  // One policy type per section in this model, named after it.
  if ((sec !== 'p' && sec !== 'g') || c.ptype !== sec) return null;
  const isRule = (r: unknown): r is string[] =>
    Array.isArray(r) && r.length >= 1 && r.length <= 6 && r.every((v) => typeof v === 'string');
  const rules = c.rules === undefined ? [] : c.rules;
  if (!Array.isArray(rules) || !rules.every(isRule)) return null;
  if (c.fieldIndex === undefined) return { sec, ptype: sec, rules };
  if (
    !Number.isInteger(c.fieldIndex) ||
    (c.fieldIndex as number) < 0 ||
    (c.fieldIndex as number) > 5 ||
    !Array.isArray(c.fieldValues) ||
    !c.fieldValues.every((v) => typeof v === 'string')
  ) {
    return null;
  }
  return {
    sec,
    ptype: sec,
    rules,
    fieldIndex: c.fieldIndex as number,
    fieldValues: c.fieldValues as string[],
  };
}

async function reconcilePolicyChange(change: PolicyChange): Promise<void> {
  const e = await getEnforcer();
  const { sec, ptype } = change;
  const candidates = [...(change.rules ?? [])];
  if (change.fieldIndex !== undefined) {
    candidates.push(
      ...e
        .getModel()
        .getFilteredPolicy(sec, ptype, change.fieldIndex, ...(change.fieldValues ?? [])),
    );
  }
  if (candidates.length === 0) return;

  const subjects = [...new Set(candidates.map((r) => r[0]!))];
  const rows = await sql<{
    v0: string | null;
    v1: string | null;
    v2: string | null;
    v3: string | null;
    v4: string | null;
    v5: string | null;
  }>`
    SELECT v0, v1, v2, v3, v4, v5 FROM zvd_permissions
    WHERE ptype = ${ptype} AND v0 = ANY(${subjects})
  `.execute(_db);
  const held = new Set(
    rows.rows.map((r) =>
      JSON.stringify([r.v0, r.v1, r.v2, r.v3, r.v4, r.v5].filter((v) => v !== null)),
    ),
  );

  // Synchronous from here to the clear (bar casbin's in-memory role-link
  // awaits), so no request reads a half-applied change and caches it.
  const touched = new Set<string>();
  for (const rule of candidates) {
    const want = held.has(JSON.stringify(rule));
    if (want === e.getModel().hasPolicy(sec, ptype, rule)) continue;
    if (want) await e.selfAddPolicy(sec, ptype, rule);
    else await e.selfRemovePolicy(sec, ptype, rule);
    touched.add(rule[0]!);
  }
  if (touched.size === 0) return;

  // After the model, not before: a check that ran in between would re-cache
  // the old answer.
  // Local only — see `cacheNamespace`. The bump also voids every socket's
  // cached subscribe decision, role link or rule alike.
  await invalidateAllPermissionCaches();
}

let _receiveChain: Promise<void> = Promise.resolve();

/** Apply a policy change another instance published. Serialized, never throws. */
export function receivePolicyChange(data: unknown): Promise<void> {
  const change = parsePolicyChange(data);
  if (!change) return _receiveChain;
  _receiveChain = _receiveChain
    .then(() => reconcilePolicyChange(change))
    .catch((err: Error) => {
      console.error(
        '[permissions] could not apply a policy change from another instance:',
        err.message,
      );
    });
  return _receiveChain;
}

// ── Periodic full reconcile ────────────────────────────────────────────────

/** The table's fingerprint when the live enforcer was loaded from it. */
let _appliedFingerprint: string | null = null;
/** Bumped when a policy write starts AND when it ends; see `trackPolicyWrite`. */
let _writeGen = 0;
let _writesInFlight = 0;

/**
 * Run a write to `zvd_permissions`. A rebuild that overlaps one cannot know
 * whether its load saw the row, so it does not swap — see `rebuildEnforcer`.
 */
export async function trackPolicyWrite<T>(write: () => Promise<T>): Promise<T> {
  _writeGen++;
  _writesInFlight++;
  try {
    return await write();
  } finally {
    _writesInFlight--;
    _writeGen++;
  }
}

/**
 * Changes on any insert, delete or edit; `id` is left out so equal tables agree.
 * `COLLATE "C"`: a locale sort took 40 ms over 7 359 rules, a byte sort 16.
 */
async function policyFingerprint(): Promise<string> {
  const r = await sql<{ fp: string | null }>`
    SELECT md5(string_agg(t, E'\n' ORDER BY t COLLATE "C")) AS fp
    FROM (SELECT json_build_array(ptype, v0, v1, v2, v3, v4, v5)::text AS t
          FROM zvd_permissions) s
  `.execute(_db);
  return r.rows[0]?.fp ?? '';
}

/**
 * Whether the live model already holds exactly the table. The bus usually
 * delivered every change, and comparing costs ~15 ms where a rebuild costs
 * ~400 ms of loading and role-link building (measured, 7 359 rules).
 */
async function liveModelMatchesTable(e: Enforcer): Promise<boolean> {
  const rows = await sql<{
    ptype: string;
    v0: string | null;
    v1: string | null;
    v2: string | null;
    v3: string | null;
    v4: string | null;
    v5: string | null;
  }>`SELECT ptype, v0, v1, v2, v3, v4, v5 FROM zvd_permissions`.execute(_db);
  const table = new Set(
    rows.rows.map((r) =>
      JSON.stringify([r.ptype, r.v0, r.v1, r.v2, r.v3, r.v4, r.v5].filter((v) => v !== null)),
    ),
  );
  let held = 0;
  for (const sec of ['p', 'g']) {
    for (const rule of e.getModel().getPolicy(sec, sec)) {
      if (!table.has(JSON.stringify([sec, ...rule]))) return false;
      held++;
    }
  }
  return held === table.size;
}

async function rebuildEnforcer(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Before the load: a write landing between the two leaves them unequal, and
    // the next tick rebuilds again instead of trusting a load that missed it.
    const fingerprint = await policyFingerprint();
    if (fingerprint === _appliedFingerprint) return false;
    const writes = _writeGen;
    const settled = () => _writesInFlight === 0 && writes === _writeGen;
    if (await liveModelMatchesTable(await getEnforcer())) {
      if (settled()) _appliedFingerprint = fingerprint;
      return false;
    }
    const fresh = await buildEnforcer();
    // A local write overlapped the load and may have gone to the old model
    // only. Try again rather than swap it away.
    if (!settled()) continue;
    _enforcer = fresh;
    _appliedFingerprint = fingerprint;
    // After the swap: bumps the generation, so a check that read the old
    // enforcer across it is not cached.
    await invalidateAllPermissionCaches();
    return true;
  }
  return false;
}

/**
 * Bring this instance's enforcer to what `zvd_permissions` holds, if the table
 * changed since it was loaded. Serialized with the bus receiver; never throws.
 * Resolves `true` when it swapped in a rebuilt enforcer.
 */
export function reconcilePolicies(): Promise<boolean> {
  const run = _receiveChain.then(rebuildEnforcer);
  _receiveChain = run.then(
    () => undefined,
    (err: Error) => {
      console.error('[permissions] policy reconcile failed:', err.message);
    },
  );
  return run.catch(() => false);
}

// 30-60 s: jittered so replicas do not all rebuild on the same second.
const RECONCILE_BASE_MS = 30_000;
let _reconcileTimer: ReturnType<typeof setTimeout> | null = null;

/** `tick` is a test seam; production always runs `reconcilePolicies`. */
export function startPolicyReconcile(tick: () => Promise<unknown> = reconcilePolicies): void {
  if (_reconcileTimer) return;
  const arm = () => {
    const timer = setTimeout(
      async () => {
        try {
          await tick();
        } finally {
          if (_reconcileTimer === timer) arm();
        }
      },
      RECONCILE_BASE_MS + Math.random() * RECONCILE_BASE_MS,
    );
    timer.unref?.();
    _reconcileTimer = timer;
  };
  arm();
}

export function stopPolicyReconcile(): void {
  if (_reconcileTimer) clearTimeout(_reconcileTimer);
  _reconcileTimer = null;
}

/**
 * Display names for a set of user ids.
 *
 * Exists because extensions need to render "who asked for this" and had no
 * legitimate way to get it. `workflow/approvals` joined the Better-Auth `user`
 * table directly — `leftJoin('user as u', 'u.id', 'r.requested_by')` at three
 * sites — which worked only because `createRestrictedDb` checked the FROM
 * table and never the JOIN. #499 closed that hole (the same gap handed
 * `session.token` to a zero-capability extension), and the join started
 * answering 500.
 *
 * A grant on `user` was the cheap answer and the wrong one: it would hand the
 * extension `email`, `role` and everything else the table grows, to render a
 * name. This returns ids mapped to names and nothing else, so the extension
 * gets exactly what it renders.
 *
 * Unknown ids are simply absent from the result — callers fall back to the id.
 * Reads the POOL handle for the same reason `resolveUserRole` does: this is
 * instance-level identity, not tenant rows, and `SAVEPOINT` against the pool
 * answers 25P01 (see the note there).
 */
export async function getUserNames(userIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return {};

  const result = await sql<{ id: string; name: string | null }>`
    SELECT id, name FROM "user" WHERE id = ANY(${ids})
  `.execute(_db);

  const out: Record<string, string> = {};
  for (const row of result.rows) {
    if (row.name) out[row.id] = row.name;
  }
  return out;
}
