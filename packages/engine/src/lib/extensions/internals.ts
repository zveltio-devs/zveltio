/**
 * The extension execution context + `ctx.internals` helper bag.
 *
 * Extracted from `extension-loader.ts` (H-04 split). `ExtensionContext` is the
 * engine-internal context handed to every extension's `register()`, extending
 * the SDK's public shape with concrete engine types. `ExtensionInternals` is the
 * lazy helper bag on `ctx.internals`, and `buildExtensionInternals()` constructs
 * it from statically-imported engine helpers (all already linked into the
 * binary, so this is just struct construction). The loader re-exports all three
 * so existing import sites keep working.
 */

import type { Context } from 'hono';
import type { ExtensionConfig, ServiceRegistry } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { getDb } from '../../db/index.js';
import type { DataApiAnswer, RlsFilter } from '@zveltio/sdk/extension';
import { dynamicInsert } from '../../db/dynamic.js';
import type { EventBus } from '../runtime/index.js';
import type { FieldTypeRegistry } from '../data/index.js';
import { DDLManager } from '../data/index.js';
import type { QueryAlterScope } from '../data/index.js';
import type { EntityAccessScope } from '../tenancy/index.js';
import {
  applyRlsFilters,
  getColumnAccess,
  getRlsFilters,
  getSingleTenantId,
  getUserNames,
  isTenantAdmin,
  requireInstanceAdmin,
  resolveUserRole,
} from '../tenancy/index.js';
import { introspectSchema } from '../introspection.js';
import {
  checkValidationExpression,
  evaluateExpressionRule,
  invalidateRulesCache,
} from '../validation-engine.js';
// The engine's own edge-function entry point — the same one `/api/fn/:name`
// calls, so an extension that runs a function gets the runner the product
// documents: a subprocess, with a memory ceiling, a minimal environment, and
// the SSRF guard.
//
// This used to be `runFunction` from `edge-functions/sandbox.js`, exported
// under this name. Two different functions called runEdgeFunction, with
// incompatible signatures: one takes an `EdgeRequest` and answers
// `{ ok, response }`, the other takes a `Request` and answers
// `{ status, body }`. The one consumer was repaired against the wrong one, and
// the probe and the test that checked the repair both reached for the wrong one
// as well — so the extension shipped throwing `request.headers.forEach is not a
// function` on every invocation. A shared name is not a contract.
import { runEdgeFunction } from '../edge-function-runner.js';
import { getCurrentDomainOrNull, withTenantIsolation } from '../tenancy/index.js';
import { applyColumnAccess } from '../tenancy/index.js';
import { checkAccess, dataApiWrite, readScope } from '../data/index.js';
import { gatePrincipal } from '../../middleware/extension-auth-gate.js';
import {
  addTenantMember,
  type IdentityMember,
  type IdentityUser,
  isSingleTenantInstance,
  listTenantUsers,
  provisionUser,
  removeTenantMember,
  setTenantMembershipEnd,
  updateUserProfile,
} from '../identity.js';
import { createRequestScopedDb } from '../tenancy/index.js';
import type { ReadScope } from '../data/index.js';
import { buildCondition } from '../../db/dynamic.js';
import { extensionRegistry } from './extension-registry.js';
import { generatePDFAsync } from '../pdf-queue.js';
import { moveToTrash } from '../cloud/trash.js';
import { enqueueDDLJob } from '../data/index.js';
import { assertPublicUrl, safeFetch, validatePublicUrl } from '../edge-functions/safe-fetch.js';
import { assertNonMetadataUrl } from '../security/index.js';
import { encryptField, maybeDecrypt, maybeEncrypt } from '../data/index.js';
import type { Keyring } from '../security/index.js';
import {
  csvCell,
  decryptWithKeyring,
  encryptWithKeyring,
  hmacAuthSecret,
  isKeyringValue,
  recordsToCsv,
} from '../security/index.js';
import { sendNotification } from '../notifications.js';
import {
  createBetterAuthSession,
  deleteUser,
  liftOwnBan,
  revokeUserSessions,
  setUserActive,
} from '../users.js';
import { bindsCaller } from './capabilities.js';
import {
  auditAs,
  countMembers,
  type DataStats,
  type ExtensionAuditEvent,
  getDataStats,
  getPublicSetting,
  listRoles,
  type MemberCounts,
  readAuditActivity,
} from './tenant-facts.js';
import type { CreateSsoSessionOptions, UserDeletion } from '../users.js';

/**
 * Internal extension context — extends the public ExtensionContext from the SDK
 * with concrete engine types (Database, FieldTypeRegistry, EventBus, DDLManager).
 * Extensions receive this at runtime but only see the public interface.
 */
export interface ExtensionContext {
  /** Tenant-scoped DB (H-12): resolves the current request/job tenant
   * transaction (RLS-isolated), or the global pool outside a tenant context.
   * Safe for normal data access — no longer the cross-tenant global handle. */
  db: Database;
  /** Host-resolved configuration (`ctx.config`) — what an extension may read
   * instead of `process.env`. Built per extension, since `objectStorage` is
   * gated by the `storage` capability. */
  config?: ExtensionConfig;
  /** Explicit CROSS-TENANT handle. Present only when the manifest declares the
   * `db:admin` permission; otherwise any use throws. For legitimately global
   * operations only (e.g. platform-wide reporting). */
  adminDb?: Database;
  /** Per-request tenant-scoped DB (request's tenant transaction + table guard).
   * Equivalent to `ctx.db` within a request; kept for handlers that pass `c`. */
  reqDb?: (c: Context) => Database;
  // Better-Auth instance. Its type is a deep generic over the configured
  // plugins/adapters; naming it here would couple the loader to the exact
  // better-auth build. Kept `any` as a documented survivor (H-04).
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance is a deep generic; documented survivor (H-04)
  auth: any;
  fieldTypeRegistry: FieldTypeRegistry;
  events: EventBus;
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  /**
   * Everything needed to refuse helpfully: whether the resource is
   * confidential, and who in this tenant can grant it. See lib/tenancy/denial.
   */
  describeDenial?: (
    resource: string,
    action: string,
  ) => Promise<{
    resource: string;
    action: string;
    confidential: boolean;
    canGrant: Array<{ name: string }>;
  }>;
  getUserRoles: (userId: string) => Promise<string[]>;
  DDLManager: typeof DDLManager;
  /** Inter-extension service registry — see service-registry.ts */
  services: ServiceRegistry;
  /** Query-alter registry — see query-alter.ts. Extensions add global WHERE
   * filters here (tenant isolation, soft-delete masks, redaction). */
  queryAlter: QueryAlterScope;
  /** Entity-access registry — see entity-access.ts. Per-record allow/deny
   * callbacks; first deny wins across all extensions. */
  entityAccess: EntityAccessScope;
  /** Register a subsystem health check surfaced at `/api/health/deep` and
   * `/api/health/<name>` (H-1.4). Namespaced `ext:<extName>:<name>`; cleared on
   * reload. Mark `critical` only if this failing should fail readiness. */
  onHealthCheck: (
    name: string,
    run: () =>
      | Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }>
      | { ok: boolean; error?: string; detail?: Record<string, unknown> },
    opts?: { critical?: boolean },
  ) => void;
  /** Escape hatch for routes on the engine's global app (outside /ext/<name>).
   * See SDK `registerPublicRoute` JSDoc for usage and trade-offs. */
  registerPublicRoute: (spec: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';
    path: string;
    handler: (c: Context) => Response | Promise<Response>;
  }) => void;
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers exposed to official extensions via ctx.internals.*.
 * Lazy-loaded at first access to avoid forcing every extension into pulling
 * heavy modules (PDF rendering, edge sandbox, etc.) when they don't need them.
 */
export interface ExtensionInternals {
  // Fields typed as `typeof <helper>` mirror the engine helper's real signature
  // (single source of truth) — no `any`, no cast in buildExtensionInternals().
  dynamicInsert: typeof dynamicInsert;
  /**
   * The three an extension needs to render a collection the way the engine's own
   * data routes do: the access check, the column mask, and the filter compiler.
   *
   * Exposed when the zones/views feature moved out of the engine. It renders
   * arbitrary collections for a portal audience, so it has to apply exactly the
   * rules `/api/data` applies — reimplementing them in the extension would be a
   * second, quietly diverging copy of the authorisation path, which is the shape
   * that produced four separate defects in this codebase already.
   */
  checkAccess: typeof checkAccess;
  applyColumnAccess: typeof applyColumnAccess;
  buildCondition: typeof buildCondition;
  introspectSchema: typeof introspectSchema;
  invalidateRulesCache: (collection: string) => void;
  /**
   * Evaluate and vet user-authored validation expressions.
   *
   * Handed to extensions because the validation extension had grown its own
   * evaluator built on `new Function('value', 'return ' + expression)`. That
   * reads as sandboxed and is not — a Function body closes over the global
   * scope, so a stored rule could reach `process` and `Bun`. The engine has
   * had a safe evaluator for the same rule type the whole time; what was
   * missing was a way for an extension to reach it.
   */
  evaluateExpressionRule: typeof evaluateExpressionRule;
  checkValidationExpression: typeof checkValidationExpression;
  /**
   * Run a callback inside a tenant transaction, outside any request.
   *
   * Extensions get `reqDb(c)` for request handlers, and nothing at all for
   * background work — so every scheduled task, queue worker and
   * fire-and-forget job in the ecosystem runs on the global pool with no
   * tenant context. `data/export` and `data/import` say so in a comment and
   * call it a follow-up; this is that follow-up, offered to every extension
   * rather than solved twice.
   *
   * The tenant has to come from wherever the work was ENQUEUED, since a job
   * has no caller to inherit from. Both the GUC and `SET LOCAL ROLE` are set,
   * so the isolation policies apply exactly as they do to a request.
   *
   * Only the tenant the work already runs as — the request's, or the job's
   * (`runAsTenantWithoutTransaction`) — unless the extension holds
   * `tenant:enter` (or `db:admin`). See `enterTenantAs`.
   */
  withTenantIsolation: <T>(tenantId: string, fn: (trx: Database) => Promise<T>) => Promise<T>;

  /**
   * The instance's own read policies, so an extension can honour them.
   *
   * `ctx.db` gives the TENANT boundary and nothing else. The two rules an
   * operator writes INSIDE a tenant — the RLS rules at `/api/rls` that hide
   * rows from a user, and the column permissions that hide a field from a role
   * — lived here and only the engine could read them. So an extension serving
   * the same data as a core route enforced strictly less, and nothing said so.
   *
   * `data/export` is the worked example: `/api/export` gained both guards on
   * 2026-07-31, the extension kept `selectAll()` inside a tenant transaction,
   * and the Studio calls the extension. Not overlooked — unavailable.
   *
   * Ungated in `INTERNALS_CAPABILITY` on purpose: every other guarded member
   * grants authority, these only remove rows and columns from a result. An
   * extension that cannot call them does not become safer.
   */
  /**
   * Apply field encryption to a value the operator marked `encrypted: true`.
   *
   * Deliberately NOT `encryptSecret`, which is gated behind `secrets` — and that
   * gate also hands over `decryptSecret`. An extension that writes rows into a
   * collection needs to honour the marking on a column; giving it the power to
   * read every stored secret in order to do so is the wrong trade, and it is the
   * reason `data/import` stored plaintext instead: the capable helper cost too
   * much, so nothing was called at all.
   *
   * Encrypt-only, so it grants nothing: what it can do is remove the extension's
   * ability to persist a marked column in the clear. Fail-closed and the
   * `ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS` escape hatch come with it,
   * because this is the engine's own helper rather than a second implementation
   * that would drift from it.
   */
  maybeEncrypt: typeof maybeEncrypt;
  /**
   * The other half of `maybeEncrypt`, without which an extension can write a
   * secret it cannot read back — so it stores plaintext instead.
   *
   * Passes through anything not carrying the `enc:v1:` prefix, which is what
   * makes adopting encryption on an existing column safe: rows written before
   * still verify, and rows written after are encrypted at rest.
   */
  maybeDecrypt: typeof maybeDecrypt;
  getRlsFilters: (
    collection: string,
    user: { id: string; email?: string; role?: string; rlsBypass?: boolean },
    authType: 'session' | 'api_key',
  ) => Promise<RlsFilter[]>;
  applyRlsFilters: <Q>(query: Q, filters: RlsFilter[]) => Q;
  /** No db parameter: the host resolves the handle — see the SDK declaration. */
  getColumnAccess: (
    collection: string,
    role: string,
  ) => Promise<{ hidden: Set<string>; readOnly: Set<string> }>;
  resolveUserRole: typeof resolveUserRole;
  /**
   * The engine's read gate — row policies, extension query alters, entity access
   * and column permissions — as one object, the same one every engine read path
   * uses. The four members above are three of those; an extension composing them
   * skipped the alters and the entity checks, which it had no way to reach.
   * Ungated, like them: it only removes rows and columns.
   */
  readScope: (
    collection: string,
    user: { id: string; email?: string; role?: string; rlsBypass?: boolean },
    authType: 'session' | 'api_key',
  ) => Promise<ReadScope>;
  /**
   * The data API's own single-record writes — `POST`, `PATCH` and `DELETE
   * /api/data/:collection[/:id]` — answering with that route's status and body.
   * Access check, column permissions, row policies, extension alters, entity
   * access, hooks and `afterWrite` (revision, webhooks, flows, realtime) are the
   * handler's, not a copy.
   *
   * They act as whoever the `/ext/*` gate admitted for `c` — session or API key,
   * with that key's scopes and authorship. There is no identity parameter: the
   * identity is the gate's, recorded before the extension ran. A context that is
   * not the running request's (a job, a listener, a forged object, one kept from
   * an earlier request) is refused; there is no default caller. Gated
   * `data:write`, unlike `readScope`, because a write is authority.
   */
  createRecord: (
    c: unknown,
    collection: string,
    data: Record<string, unknown>,
  ) => Promise<DataApiAnswer>;
  updateRecord: (
    c: unknown,
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ) => Promise<DataApiAnswer>;
  deleteRecord: (c: unknown, collection: string, id: string) => Promise<DataApiAnswer>;
  /**
   * The tenant to add as an explicit `tenant_id =` beside the policy, or `null`
   * when one must not be added.
   *
   * The RLS policy reads `tenant_id = ANY (…)` over an array the planner does
   * not see until execution, so it cannot drive an ordered index scan. A read
   * that filters and orders therefore walks the `created_at` index and discards
   * whatever the policy excludes. Measured on 300 000 rows with the policy
   * applied: 46 ms, and every row in the table discarded to return 25 — at ten
   * tenants and at a hundred alike.
   *
   * Adding the equality removes that. It is PERFORMANCE ONLY: the policy still
   * decides what may be seen, and an equality can only narrow the set the policy
   * already allows, never widen it.
   *
   * Returns `null` whenever the request's reach is wider than one tenant — a
   * subtree or org assignment — because narrowing there would hide rows the
   * caller is entitled to. So the safe shape is simply:
   *
   *     const t = ctx.internals.getSingleTenantId();
   *     if (t) q = q.where('tenant_id', '=', t);
   *
   * There is no correct way to apply this automatically to an extension's own
   * queries: `ctx.db` is a Kysely instance, not a rewriter, and it cannot know
   * which column of an arbitrary query carries the tenant.
   */
  getSingleTenantId: typeof getSingleTenantId;
  /**
   * Display names for a set of user ids, as `{ [id]: name }`. Ids with no row,
   * or with a null name, are absent — render the id instead.
   *
   * Extensions cannot read the Better-Auth `user` table (see
   * `createRestrictedDb`), and rendering "who asked for this" is a real need:
   * `workflow/approvals` had been joining that table directly through a gap in
   * the guard. This hands over names and nothing else, so no extension needs a
   * grant on a table holding emails and roles in order to print a name.
   */
  getUserNames: typeof getUserNames;
  /**
   * Facts about the tenant this work runs as — see `tenant-facts.ts`. They
   * replace raw SQL on `"user"`, `zv_tenant_users`, `zv_tenants`, `pg_class`,
   * `zvd_permissions` and `zv_settings`, which `ctx.db` refuses.
   */
  countMembers: () => Promise<MemberCounts>;
  getDataStats: () => Promise<DataStats>;
  listRoles: () => Promise<string[]>;
  getPublicSetting: (key: string) => Promise<unknown>;
  /** Append to `zv_audit_log`; the row records the calling extension in `metadata.extension`. */
  audit: (event: ExtensionAuditEvent) => Promise<void>;
  readAuditActivity: typeof readAuditActivity;
  isTenantAdmin: typeof isTenantAdmin;
  /**
   * Instance-level admin, as distinct from admin-within-a-tenant.
   *
   * `checkPermission(uid, 'admin', '*')` is TRUE for a delegated tenant owner
   * inside their own domain, because the `tenant_owner` policy is `('*','*','*')`
   * there. That is the right answer for tenant-scoped screens and the wrong one
   * for anything touching the instance: raw SQL, schema, role grants.
   *
   * Exposed because an extension that cannot reach this helper writes the
   * `checkPermission` version instead — developer/database did, on a raw-SQL
   * route, which is how a tenant admin got an instance-wide query console.
   */
  requireInstanceAdmin: typeof requireInstanceAdmin;
  runEdgeFunction: typeof runEdgeFunction;
  extensionRegistry: typeof extensionRegistry;
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  /** Soft-delete a media file of the tenant the work runs as — never one named
   *  by an argument; a fourth argument is not read. Gated `files`. */
  moveToTrash: (db: Database, fileId: string, deletedBy: string) => Promise<void>;
  enqueueDDLJob: typeof enqueueDDLJob;
  /**
   * Synchronous literal-host SSRF check. Throws on a blocked URL, returns
   * nothing. Declared `Promise<URL>` here for a long time, which was simply
   * wrong — the function is sync and returns void. It matters: an author who
   * believed the signature and wrote `await ctx.validatePublicUrl(u)` in an
   * async guard would still be validating, but one who branched on the
   * resolved value got `undefined`. Callers in a sync context (e.g. a zod
   * superRefine) depend on it staying synchronous.
   */
  validatePublicUrl: (url: string) => void;
  /**
   * DNS-aware SSRF check — everything validatePublicUrl does, plus rejecting
   * hostnames that RESOLVE into private space. Prefer this whenever the call
   * site can await; it is the only variant that stops an attacker-controlled
   * name pointing at cloud metadata. MUST be awaited.
   */
  /**
   * Resolves to the address the caller should connect to, or null when there is
   * nothing to pin (an IP literal, or a name that did not resolve). An
   * extension that ignores the value gets exactly the old behaviour; one that
   * uses it closes the rebinding race, as `safeFetch` does.
   */
  assertPublicUrl: (url: string) => Promise<string | null>;
  /**
   * `fetch`, with the SSRF guard applied where it actually has to be.
   *
   * Validating a URL before calling `fetch` is not enough on its own: fetch
   * follows redirects, so a public host answering 302 to 169.254.169.254 walks
   * straight past a check performed on the original URL. This intercepts each
   * redirect and re-validates the target, under a hop limit.
   *
   * Exposed because api-connector had grown its own `safeFetch` around a
   * literal-hostname blocklist — the same guard this engine had already
   * replaced with a DNS-aware one. An extension that cannot reach the good
   * implementation writes the bad one.
   */
  safeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /**
   * SSRF guard for an admin-configured endpoint that is ALLOWED to be
   * self-hosted (local Ollama, internal Meilisearch, on-prem object storage).
   * Permits private ranges but rejects cloud-metadata hosts. Use this — NOT
   * validatePublicUrl/assertPublicUrl — for provider "base URL" settings, or
   * you will break every localhost deployment. Synchronous; throws when blocked.
   */
  assertNonMetadataUrl: (url: string, label?: string) => void;
  // NOT `typeof sendNotification`: the SDK's public ExtensionContext declares a
  // looser `input` (message optional) than the engine helper (message required),
  // so this slot must stay at least as loose as the SDK's. `unknown` params keep
  // it loose without `any`; the real (stricter) fn is cast in buildExtensionInternals.
  sendNotification: (db: unknown, input: unknown) => Promise<void>;
  /** Sign in a user the extension verified, where better-auth reads sessions.
   *  `db` is the caller's transaction; the write is better-auth's. See
   *  `lib/users.ts`. Gated `auth:session`. */
  createBetterAuthSession: (
    db: unknown,
    userId: string,
    opts?: CreateSsoSessionOptions,
  ) => Promise<{ token: string; setCookie: string }>;
  /**
   * Encrypt with a host-held key. `keyring` selects WHICH key: 'field' (the
   * default, FIELD_ENCRYPTION_KEY) or 'mail' (MAIL_ENCRYPTION_KEY), so an
   * extension never has to hold key material to get blast-radius separation.
   */
  encryptSecret: (plaintext: string, opts?: { keyring?: Keyring }) => Promise<string>;
  /** Decrypt a value produced by `encryptSecret`, or by the per-extension
   * crypto that predated it — the envelope selects the key. */
  decryptSecret: (value: string, opts?: { keyring?: Keyring }) => Promise<string>;
  /**
   * HMAC-SHA256 under the instance auth secret, hex encoded. A compatibility
   * surface for auth/scim's stored bearer-token hashes — not a general MAC.
   */
  deriveTokenHash: (raw: string) => Promise<string>;
  /**
   * Quoted, formula-safe CSV cell. Ungated: a pure string function with no
   * authority. Exposed because every extension that exports CSV was writing its
   * own escaping, and quoting alone does not stop a spreadsheet executing a
   * cell that starts with `=`.
   */
  csvCell: (value: unknown) => string;
  /** Rows → CSV document, using `csvCell` for every cell. */
  recordsToCsv: (records: Record<string, unknown>[]) => string;
  /** `DELETE /api/users/:id` for an extension — see `lib/users.ts`. `db` is the
   *  caller's transaction; the privileged pool is the host's. Gated `auth:users`. */
  deleteUser: (db: unknown, userId: string, who: UserDeletion) => Promise<boolean>;
  /** End a user's sessions (DB and cache). Gated `auth:users`. */
  revokeUserSessions: (userId: string) => Promise<void>;
  /** Block (`false`, and every session revoked) or restore sign-in by every
   *  method. A ban records the calling extension as its source; `true` lifts
   *  any ban. `db` is the caller's transaction. Gated `auth:users`. */
  setUserActive: (db: unknown, userId: string, active: boolean) => Promise<void>;
  /** Lift the user's ban only if the calling extension placed it; whether it
   *  did. `db` is the caller's transaction. Gated `auth:users`. */
  liftOwnBan: (db: unknown, userId: string) => Promise<boolean>;
  // Identity provisioning — see `lib/identity.ts`. All but
  // `isSingleTenantInstance` are gated `identity:provision`; membership is the
  // RUNNING tenant's. A refusal throws `IdentityRefusedError` with a `code`.
  /** Whether at most one tenant exists (so every user belongs to it). Ungated. */
  isSingleTenantInstance: () => Promise<boolean>;
  /** Find-or-create a verified, passwordless account by email. */
  provisionUser: (input: {
    email: string;
    name?: string;
  }) => Promise<{ user: IdentityUser; created: boolean }>;
  /** Users of the running tenant (every user on a single-tenant instance). */
  listTenantUsers: (
    db: unknown,
    query?: { email?: string; userId?: string; limit?: number; offset?: number },
  ) => Promise<IdentityMember[]>;
  /** Rename / re-address a user the running tenant alone holds. */
  updateUserProfile: (
    db: unknown,
    userId: string,
    patch: { name?: string; email?: string },
  ) => Promise<IdentityUser>;
  /** Join the running tenant as `member` (default) or `viewer`, or switch between them. */
  addTenantMember: (
    db: unknown,
    userId: string,
    role?: 'member' | 'viewer',
  ) => Promise<'added' | 'role_changed' | 'unchanged'>;
  /** Leave the running tenant; whether the account is now orphaned. */
  removeTenantMember: (
    db: unknown,
    userId: string,
  ) => Promise<{ removed: boolean; orphaned: boolean; inForceAnywhere: boolean }>;
  /** When the running tenant's membership ends ('now', ISO instant, or null). */
  setTenantMembershipEnd: (
    db: unknown,
    userId: string,
    validTo: string | null,
    guard?: { ifInForce?: boolean; ifValidTo?: string | null },
  ) => Promise<{
    changed: boolean;
    previousValidTo: string | null;
    validTo: string | null;
    inForceAnywhere: boolean;
  } | null>;
}

/** A caller-bound member reached without `gateInternals`: there is no caller. */
const unbound = (member: string) => () => {
  throw new Error(
    `ctx.internals.${member} acts as the calling extension, and this bag was not ` +
      'handed to one: reach it through gateInternals.',
  );
};

/** One data API write, as the caller the `/ext/*` gate admitted for `c`. */
function writeAsCaller(op: 'create' | 'update' | 'delete') {
  return async (
    c: unknown,
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<DataApiAnswer> => {
    const p = gatePrincipal(c);
    if (!p) {
      throw new Error(
        `ctx.internals.${op}Record: pass the request context \`c\` of the /ext/* request ` +
          'being handled. Writes act as the caller that request authenticated; outside ' +
          'one there is no caller, so there is no write.',
      );
    }
    const res = await dataApiWrite(op, c as Context, createRequestScopedDb(getDb()), {
      collection,
      id,
      body: async () => data,
      user: p.user,
      authType: p.authType,
      trx: p.trx,
      tenantId: p.tenantId,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}
const createAsCaller = writeAsCaller('create');
const updateAsCaller = writeAsCaller('update');
const deleteAsCaller = writeAsCaller('delete');

/**
 * `withTenantIsolation` as an extension gets it: the tenant must be the one the
 * work already runs as, unless the extension holds `tenant:enter` (or
 * `db:admin`, which implies it).
 *
 * It was handed over raw, so the tenant was whatever the extension passed: an
 * extension with no capability, serving a request in firm A, opened a
 * transaction as firm B and read B's rows — more than `ctx.adminDb` grants, and
 * that needs `db:admin`. The running tenant is the domain in the async context,
 * set by the host (tenant middleware, flow scheduler), never by an argument.
 * Outside any — load time, a timer — there is no tenant to inherit, so only
 * `tenant:enter` enters one.
 */
function enterTenantAs(
  caller: string,
  anyTenant: boolean,
): ExtensionInternals['withTenantIsolation'] {
  return (tenantId, fn) => {
    const running = getCurrentDomainOrNull();
    if (anyTenant || tenantId === running) return withTenantIsolation(tenantId, fn);
    return Promise.reject(
      new Error(
        `${caller}: ctx.internals.withTenantIsolation("${tenantId}") refused — this work runs ` +
          (running ? `as tenant "${running}"` : 'as no tenant') +
          ', and entering another needs the "tenant:enter" capability (declared in ' +
          'manifest.json and approved by an administrator).',
      ),
    );
  };
}

/**
 * Build the `ctx.internals` object passed to every extension. All helpers are
 * statically imported above and already linked into the engine binary — building
 * the object is just struct construction. Called once by the engine bootstrap
 * (index.ts) and passed to `loadAll`.
 */
export function buildExtensionInternals(): ExtensionInternals {
  return bindsCaller(buildUnboundInternals(), (caller, granted) => ({
    provisionUser: (input) => provisionUser(input, caller),
    updateUserProfile: (db, userId, patch) =>
      updateUserProfile(db as Database, userId, patch, caller),
    addTenantMember: (db, userId, role = 'member') =>
      addTenantMember(db as Database, userId, role, caller),
    removeTenantMember: (db, userId) => removeTenantMember(db as Database, userId, caller),
    setTenantMembershipEnd: (db, userId, validTo, guard) =>
      setTenantMembershipEnd(db as Database, userId, validTo, guard, caller),
    withTenantIsolation: enterTenantAs(
      caller,
      granted.has('db:admin') || granted.has('tenant:enter'),
    ),
    setUserActive: (db: unknown, userId: string, active: boolean) =>
      setUserActive(db as Database, getDb(), userId, active, caller),
    liftOwnBan: (db: unknown, userId: string) => liftOwnBan(db as Database, userId, caller),
    audit: (event: ExtensionAuditEvent) => auditAs(caller, event),
  }));
}

function buildUnboundInternals(): ExtensionInternals {
  return {
    withTenantIsolation,
    checkAccess,
    applyColumnAccess,
    buildCondition,
    dynamicInsert,
    introspectSchema,
    invalidateRulesCache,
    evaluateExpressionRule,
    checkValidationExpression,
    runEdgeFunction,
    extensionRegistry,
    generatePDFAsync: generatePDFAsync as ExtensionInternals['generatePDFAsync'],
    // The tenant is the host's: the domain the request or job runs as. The
    // helper's tenant filter was an optional fourth argument the catalogue never
    // passed, and it is the only boundary where the row policy does not bind.
    moveToTrash: (db: Database, fileId: string, deletedBy: string) => {
      const tenant = getCurrentDomainOrNull();
      if (!tenant) {
        return Promise.reject(
          new Error('ctx.internals.moveToTrash: no tenant runs here, so there is no file to trash'),
        );
      }
      return moveToTrash(db, fileId, deletedBy, tenant);
    },
    maybeEncrypt,
    maybeDecrypt,
    // Adapted rather than passed straight through, so the bag matches the SDK
    // declaration exactly. The casts are between two spellings of the same
    // shape — `RlsFilter` mirrors the engine's `FilterCondition` — and exist so
    // neither side has to widen a parameter to `any` to stay assignable.
    getRlsFilters: (
      collection: string,
      user: { id: string; email?: string; role?: string; rlsBypass?: boolean },
      authType: 'session' | 'api_key',
    ) => getRlsFilters(collection, user, authType) as Promise<RlsFilter[]>,
    applyRlsFilters: <Q>(query: Q, filters: RlsFilter[]): Q =>
      applyRlsFilters(query, filters as Parameters<typeof applyRlsFilters>[1]),
    // The handle is the host's to choose: column permissions are instance
    // configuration, not tenant rows.
    // `userId` is additive and optional: an extension built against the older
    // three-argument signature keeps working, and gets no exemption, which is
    // the refusing direction. Pass the acting user's id to have the host
    // resolve `data:view_all_columns` for them — that is how a god sees every
    // column through an extension, the same way it does through the data API.
    getColumnAccess: (collection: string, role: string, userId?: string) =>
      getColumnAccess(getDb(), collection, role, userId),
    resolveUserRole,
    // The host picks the handle, as for `getColumnAccess`.
    readScope: (collection, user, authType) => readScope(getDb(), collection, user, authType),
    // Fixed arity: anything an extension passes past these is never read.
    createRecord: (c, collection, data) => createAsCaller(c, collection, '', data),
    updateRecord: (c, collection, id, data) => updateAsCaller(c, collection, id, data),
    deleteRecord: (c, collection, id) => deleteAsCaller(c, collection, id, {}),
    getUserNames,
    countMembers: () => countMembers(),
    getDataStats: () => getDataStats(),
    listRoles,
    getPublicSetting: (key: string) => getPublicSetting(key),
    audit: unbound('audit'),
    // Arity fixed, as for the facts above: the tenant is the host's.
    readAuditActivity: (query) => readAuditActivity(query),
    getSingleTenantId,
    isTenantAdmin,
    requireInstanceAdmin,
    enqueueDDLJob,
    validatePublicUrl,
    assertPublicUrl,
    safeFetch,
    assertNonMetadataUrl,
    sendNotification: sendNotification as ExtensionInternals['sendNotification'],
    createBetterAuthSession: (db: unknown, userId: string, opts?: CreateSsoSessionOptions) =>
      createBetterAuthSession(db as Database, getDb(), userId, opts),
    encryptSecret: async (plaintext: string, opts?: { keyring?: Keyring }) => {
      const keyring = opts?.keyring ?? 'field';
      // Already-encrypted input is returned untouched so a caller that
      // re-saves a record does not double-wrap what it read.
      if (isKeyringValue(plaintext)) return plaintext;
      if (keyring === 'field') return encryptField(plaintext);
      return encryptWithKeyring(plaintext, keyring);
    },
    decryptSecret: async (value: string, opts?: { keyring?: Keyring }) => {
      if (!isKeyringValue(value)) return value;
      return decryptWithKeyring(value, opts?.keyring ?? 'field');
    },
    deriveTokenHash: hmacAuthSecret,
    csvCell,
    recordsToCsv,
    deleteUser: (db: unknown, userId: string, who: UserDeletion) =>
      deleteUser(db as Database, getDb(), userId, who),
    revokeUserSessions: (userId: string) => revokeUserSessions(getDb(), userId),
    setUserActive: unbound('setUserActive'),
    liftOwnBan: unbound('liftOwnBan'),
    isSingleTenantInstance: () => isSingleTenantInstance(),
    listTenantUsers: (db, query) => listTenantUsers(db as Database, query),
    provisionUser: unbound('provisionUser'),
    updateUserProfile: unbound('updateUserProfile'),
    addTenantMember: unbound('addTenantMember'),
    removeTenantMember: unbound('removeTenantMember'),
    setTenantMembershipEnd: unbound('setTenantMembershipEnd'),
  };
}
