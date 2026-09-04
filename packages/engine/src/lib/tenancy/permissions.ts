import { createHmac, timingSafeEqual } from 'crypto';
import { Helper, newEnforcer, newModelFromString, type Enforcer } from 'casbin';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getCache } from '../runtime/index.js';
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

/** Dropped whenever policies change, so a newly named resource stops collapsing. */
function invalidatePolicyObjectIndex(): void {
  _policyObjects = null;
}

async function policyObjectIndex(): Promise<Set<string>> {
  if (_policyObjects) return _policyObjects;
  const e = await getEnforcer();
  const index = new Set<string>();
  for (const rule of await e.getPolicy()) {
    const obj = rule[2];
    if (typeof obj === 'string') index.add(obj);
  }
  _policyObjects = index;
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
  // Key shape: `perm:${domain}:${userId}:${resource}:${action}`
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  async loadPolicy(model: any): Promise<void> {
    clearLocalPermissionCache();
    invalidatePolicyObjectIndex();
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

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3, v4, v5)
      VALUES (${ptype}, ${rule[0] ?? null}, ${rule[1] ?? null}, ${rule[2] ?? null},
              ${rule[3] ?? null}, ${rule[4] ?? null}, ${rule[5] ?? null})
    `.execute(_db);
  }

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    clearLocalPermissionCache();
    invalidatePolicyObjectIndex();
    // 4-token policies (p: sub,dom,obj,act) — match all provided columns.
    await sql`
      DELETE FROM zvd_permissions
      WHERE ptype = ${ptype} AND v0 = ${rule[0] ?? null} AND v1 = ${rule[1] ?? null}
        AND v2 = ${rule[2] ?? null} AND v3 = ${rule[3] ?? null}
    `.execute(_db);
  }

  async removeFilteredPolicy(
    _sec: string,
    ptype: string,
    _fieldIndex: number,
    ...fieldValues: (string | undefined)[]
  ): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const conditions: any[] = [sql`ptype = ${ptype}`];
    if (fieldValues[0] !== undefined) conditions.push(sql`v0 = ${fieldValues[0]}`);
    if (fieldValues[1] !== undefined) conditions.push(sql`v1 = ${fieldValues[1]}`);
    if (fieldValues[2] !== undefined) conditions.push(sql`v2 = ${fieldValues[2]}`);
    if (fieldValues[3] !== undefined) conditions.push(sql`v3 = ${fieldValues[3]}`);

    await sql`DELETE FROM zvd_permissions WHERE ${sql.join(conditions, sql` AND `)}`.execute(_db);
  }
}

export async function initPermissions(db: Database): Promise<void> {
  _db = db;
  const model = newModelFromString(CASBIN_MODEL);
  _enforcer = await newEnforcer(model, new KyselyCasbinAdapter());
  // Make '*' a wildcard domain in role grants (g): a grant `(user, role, '*')`
  // then applies in every tenant. Validated against casbin 5.x.
  _enforcer.addNamedDomainMatchingFunc('g', (r: string, p: string) => p === '*' || r === p);

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
 * member, and fails to `'public'` — the least-privileged role — when the
 * database is unreachable.
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
        const decoded = _decodeRolesCache(userId, raw);
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
  try {
    const result = await sql<{ role: string }>`
      SELECT role FROM "user" WHERE id = ${userId} LIMIT 1
    `.execute(_db);
    const role = result.rows[0]?.role || 'public';
    _localRole.set(userId, { value: role, at: Date.now() });
    if (cache) {
      try {
        await cache.setex(cacheKey, GOD_CACHE_TTL, _encodeRolesCache(userId, [role]));
      } catch {
        /* cache unavailable */
      }
    }
    return role;
  } catch {
    return 'public'; // fail closed — least privilege when the DB is down
  }
}

export async function isGodUser(userId: string): Promise<boolean> {
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
  try {
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
  } catch {
    return false; // Fail closed — if DB is down, do NOT grant god access
  }
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
    // O(1) — DEL on a single, fully-qualified key.
    await cache.del(`god:${userId}`);
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
  const isGod = await isGodUser(userId);
  if (isGod) return true;

  const domain = getCurrentDomain();
  const cache = getCache();
  // A name no policy mentions cannot change the answer — see `policyObjectIndex`.
  // Filing every such name under one key is what stops an invented-name flood
  // from costing one full `enforce()` each.
  const named = (await policyObjectIndex()).has(resource) ? resource : UNKNOWN_RESOURCE;
  const cacheKey = `perm:${domain}:${userId}:${named}:${action}`;

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

  if (cache) {
    try {
      // Store HMAC-signed value — prevents privilege escalation via Redis writes.
      await cache.setex(cacheKey, PERMISSION_CACHE_TTL, _encodePermCache(cacheKey, result));
      await cache.sadd(`user:perm-keys:${userId}`, cacheKey);
      await cache.expire(`user:perm-keys:${userId}`, PERMISSION_CACHE_TTL + 60);
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
function _rolesHmac(userId: string, rolesJson: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error('[permissions] BETTER_AUTH_SECRET is not set — cannot sign roles cache entry');
  return createHmac('sha256', secret).update(`roles:${userId}:${rolesJson}`).digest('hex');
}

function _encodeRolesCache(userId: string, roles: string[]): string {
  const json = JSON.stringify(roles);
  return `${json}:${_rolesHmac(userId, json)}`;
}

/** Returns the roles array if HMAC is valid, `null` if tampered / malformed. */
function _decodeRolesCache(userId: string, raw: string): string[] | null {
  // HMAC is always 64 hex chars; separator is ':'
  const HMAC_LEN = 64;
  if (raw.length < HMAC_LEN + 2) return null; // at minimum '[]' + ':' + 64 chars
  const storedHmac = raw.slice(raw.length - HMAC_LEN);
  const json = raw.slice(0, raw.length - HMAC_LEN - 1); // strip ':' + hmac
  try {
    const expected = Buffer.from(_rolesHmac(userId, json), 'hex');
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
  const cacheKey = `roles:${domain}:${userId}`;

  if (cache) {
    try {
      // GET — O(1): direct key lookup.
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        // Verify HMAC — null means tampered, fall through to DB (fail-closed)
        const decoded = _decodeRolesCache(userId, cached);
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

  if (cache) {
    try {
      // SETEX  — O(1): write HMAC-signed roles under a single key.
      // SADD   — O(1): register this key in the per-user tracking Set.
      // EXPIRE — O(1): keeps the tracking Set TTL aligned with its contents.
      await cache.setex(cacheKey, ROLE_CACHE_TTL, _encodeRolesCache(userId, roles));
      await cache.sadd(`user:perm-keys:${userId}`, cacheKey);
      await cache.expire(`user:perm-keys:${userId}`, ROLE_CACHE_TTL + 60);
    } catch {
      /* cache unavailable */
    }
  }

  return roles;
}

/**
 * Invalidates all permission and role cache entries for a single user.
 *
 * Design: instead of scanning the keyspace (KEYS or SCAN), every cache write
 * registers its key in a per-user Set (`user:perm-keys:{userId}`).
 * Invalidation then reads only that Set and deletes the listed keys.
 *
 * Complexity breakdown:
 *   SMEMBERS user:perm-keys:{userId}
 *     — O(M) where M = number of distinct (resource, action) pairs ever checked
 *       for this user. M is bounded by the user's own policy surface (typically
 *       single-digit to low tens), not by the total number of keys in Valkey.
 *
 *   DEL key₁ key₂ … keyₘ  roles:{userId}  user:perm-keys:{userId}
 *     — O(M + 2) = O(M): removes M permission keys plus the roles and
 *       tracking-Set keys in a single round-trip.
 *
 *   Total invalidation cost: O(M) — strictly scoped to this user.
 *
 * Comparison with alternatives:
 *   KEYS perm:${userId}:*   — O(N) over the full keyspace; blocks Valkey while
 *                              iterating; prohibited in production.
 *   SCAN cursor MATCH …     — O(N) total across all iterations; non-blocking per
 *                              call but still touches every key slot; unnecessary
 *                              here because we track keys explicitly at write time.
 */
export async function invalidateUserPermCache(userId: string): Promise<void> {
  clearLocalPermissionCache(userId);
  const cache = getCache();
  if (cache) {
    try {
      // O(M) — SMEMBERS returns all members of the per-user tracking Set.
      //        M is the number of distinct permission checks cached for this user.
      const permKeys = await cache.smembers(`user:perm-keys:${userId}`);

      // Role keys (roles:${domain}:${userId}) are registered in permKeys via getUserRoles().
      // god / urole must be cleared on any permission change (TTLs differ from perm cache).
      const allKeys = [...permKeys, `god:${userId}`, `urole:${userId}`, `user:perm-keys:${userId}`];
      if (allKeys.length > 0) await cache.del(...allKeys);
    } catch {
      /* cache unavailable */
    }
  }
  // The query cache holds rows already RLS-filtered + column-masked for this
  // user's role — a role grant/revoke must drop them too, or the change is
  // served stale for up to the TTL.
  const { invalidateUserQueryCache } = await import('../data/index.js');
  await invalidateUserQueryCache(userId);
  // Open WebSocket sessions cache subscribe decisions for WS_PERM_CACHE_TTL_MS —
  // clear those too so a revoke is visible on the next subscribe without waiting
  // for the TTL (or a reconnect). Dynamic import avoids tenancy → routes cycle.
  try {
    const { invalidateWsUserPermCache } = await import('../../routes/ws.js');
    invalidateWsUserPermCache(userId);
  } catch {
    /* ws module unavailable in some unit-test graphs */
  }
}
