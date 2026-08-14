import type { Hono } from 'hono';
import type { Kysely } from 'kysely';

export { permissionGate } from './permission-gate.js';

// ─────────────────────────────────────────────────────────────────────────────
// Zveltio Extension API — public types for extension authors
//
// This is the single source of truth for extension types.
// Both the engine (which loads extensions) and extension authors (who implement
// them) use these interfaces.  Engine-internal types (EventBus, DDLManager)
// stay as `any` so extensions compile without depending on engine internals.
//
// The `DB` generic parameter on `ExtensionContext<DB>` and `ZveltioExtension<DB>`
// (S4-02) lets an extension thread its codegen'd schema type (via
// `zveltio extension types` — S4-01) through to `ctx.db`. Default is `any`
// for back-compat with extensions that don't (yet) generate types.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row-level-security condition, as `getRlsFilters` produces it and
 * `applyRlsFilters` consumes it. Opaque in practice — an extension passes the
 * array straight through rather than reading it.
 */
export interface RlsFilter {
  readonly field: string;
  readonly condition: { readonly op: string; readonly value?: unknown };
}

export interface FieldTypeRegistryAPI {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  register(definition: any): void;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  get(type: string): any;
  has(type: string): boolean;
  list(): string[];
  /**
   * Full list of registered field type definitions. Distinct from
   * `list()` which returns just the type names — `getAll()` returns
   * the registered metadata records (label, validators, default
   * value, etc.). Used by AI/schema-generation tooling.
   */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  getAll(): Array<{ type: string; [key: string]: any }>;
  /** Coerce a value FROM the database representation INTO its TS shape. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  deserialize(type: string, value: any): any;
  /** Coerce a value FROM its TS shape INTO the database representation. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  serialize(type: string, value: any): any;
}

/**
 * Object storage settings, handed to extensions that declare the `storage`
 * capability. `undefined` on `ExtensionConfig` means the instance has no object
 * storage configured — degrade (keep metadata, skip the bytes), don't throw.
 *
 * Resolved from the same source the engine uses, which includes the admin's
 * Studio settings. Reading `S3_*` from the environment instead misses that
 * overlay entirely and sees an unconfigured instance.
 */
export interface ObjectStorageConfig {
  /** Endpoint origin, no trailing slash. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Public base URL for reads, when the deployment serves one. */
  readonly publicUrl?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The configuration an extension may read — `ctx.config`.
 *
 * Use this instead of `process.env`. An in-process extension reading the
 * environment gets the whole ENGINE environment (database credentials, the auth
 * secret, the field-encryption key), which is both more than any extension
 * needs and a way around the capability gate on `ctx.internals`.
 *
 * Values are live: read them when you need them rather than caching at module
 * scope, because an administrator can change storage settings at runtime.
 */
export interface ExtensionConfig {
  readonly env: 'production' | 'development' | 'test';
  readonly isProduction: boolean;
  /** The engine's public base URL, when the deployment sets one. */
  readonly publicUrl?: string;
  /**
   * Whether the instance has a field-encryption key configured. A boolean by
   * design — to encrypt something use `ctx.internals.encryptSecret`, which is
   * gated by the `secrets` capability. Extensions do not hold key material.
   */
  readonly encryptionConfigured: boolean;
  readonly crossDomainAuth: boolean;
  /** Permits plaintext LDAP binds. Development only. */
  readonly allowInsecureLdap: boolean;
  /** Present only with the `storage` capability, and only when configured. */
  readonly objectStorage?: ObjectStorageConfig;
}

/**
 * Context injected into every extension's `register()` call.
 *
 * The `DB` generic threads the extension's codegen'd database schema
 * (`@zveltio/sdk/codegen` → `<ext>/.zveltio/db.d.ts`) through to `ctx.db`.
 * Default `any` keeps legacy extensions compiling untouched. Migrated
 * extensions get full Kysely autocomplete + typo detection.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export interface ExtensionContext<DB = any> {
  // ─── Stable public API ───────────────────────────────────────────────────────

  /**
   * Kysely database instance (restricted — cannot query zv_* system tables).
   * Typed via the `DB` generic; use `ZveltioExtension<MySchema>` to opt in.
   *
   * TENANT-SCOPED (since H-12): queries run against the current request/job
   * tenant's transaction (so the `zveltio.current_tenant` GUC is set and
   * FORCE-RLS rows are isolated), or the global pool outside any tenant context
   * (boot/migrations). You no longer need `ctx.reqDb(c)` for isolation — `ctx.db`
   * is safe by default. For explicit CROSS-tenant access, see `ctx.adminDb`.
   */
  db: Kysely<DB>;
  /**
   * Configuration this extension may read. Use it instead of `process.env` —
   * see `ExtensionConfig`.
   *
   * Typed optional so partial/bootstrap contexts type-check; always present on
   * the context the engine hands a loaded extension.
   */
  config?: ExtensionConfig;
  /**
   * Explicit CROSS-TENANT database handle (the global pool). Present ONLY when
   * the manifest declares the `db:admin` permission — otherwise any query throws.
   * Use for legitimately global operations (platform-wide reporting, backup).
   * Declaring `db:admin` surfaces the cross-tenant access at review + install.
   */
  adminDb?: Kysely<DB>;
  /**
   * Per-request, tenant-scoped database. Returns the request's tenant
   * transaction (so the `zveltio.current_tenant` GUC is set and FORCE-RLS rows
   * are visible + isolated), wrapped in the same table-restriction guard as
   * `ctx.db`. Pass the route's Hono context: `const db = ctx.reqDb(c)`.
   *
   * Always present on the context the engine hands to a loaded extension; typed
   * optional only so partial/bootstrap contexts type-check. In a data handler
   * use it directly — `ctx.reqDb(c)`.
   */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  reqDb?: (c: any) => Kysely<DB>;
  /** Better-Auth instance — use `ctx.auth.api.getSession({ headers })` in route handlers. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  auth: any;
  /** Field type registry — register custom field types here. */
  fieldTypeRegistry: FieldTypeRegistryAPI;
  /** Typed event bus — subscribe to record lifecycle events (insert/update/delete). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  events: any;
  /** Check if a user has permission for a resource/action. */
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  /** Get all roles assigned to a user. */
  getUserRoles: (userId: string) => Promise<string[]>;
  /**
   * DDLManager — schema-migration utilities for collections and fields
   * (S4-08). See `@zveltio/sdk/ddl` for the interface. The engine owns the
   * implementation; extensions use the instance handed in here. Typed as
   * `any` at this layer (vs the SDK's DDLManager interface) so existing
   * `ctx.DDLManager` call sites in the 50+ extensions don't break when
   * upgrading; opt in to the typed surface with:
   *
   *   import type { DDLManager } from '@zveltio/sdk/ddl';
   *   const ddl: DDLManager = ctx.DDLManager;
   */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  DDLManager: any;

  /**
   * Inter-extension service registry. Extensions publish services here for other
   * extensions to consume. Stable public API — use this for cross-extension
   * communication instead of direct imports.
   */
  services: ServiceRegistry;

  /**
   * Query-alter registry. Register a function per table that the data layer
   * will call before executing SELECT queries on that table — typical uses
   * are tenant isolation, soft-delete filtering, and column redaction.
   *
   * @example
   *   ctx.queryAlter.register({
   *     table: 'zvd_contacts',
   *     alter(qb, user) {
   *       if (user.isGod) return qb;
   *       return qb.where('tenant_id', '=', user.tenantId);
   *     },
   *   });
   *
   * Alters are scoped to the registering extension — removed automatically on
   * unload / hot-reload. Today's scope: SELECT queries only.
   */
  queryAlter: QueryAlterScope;

  /**
   * Per-record authorization callbacks. Return `'deny'` to block access to
   * a specific row; first deny across all extensions wins. See
   * `EntityAccessScope` for an example.
   */
  entityAccess: EntityAccessScope;

  /**
   * Register a subsystem health check surfaced at `GET /api/health/deep` and
   * `GET /api/health/<name>`. Use it to report the liveness of anything your
   * extension owns (an external API, a worker, a provider):
   *
   *   ctx.onHealthCheck('smtp', async () => {
   *     const ok = await pingSmtp();
   *     return { ok, detail: { host: SMTP_HOST } };
   *   });
   *
   * Checks are namespaced `ext:<yourExtension>:<name>` and cleared on reload.
   * Mark `{ critical: true }` only if your extension being down should fail the
   * engine's readiness probe (rarely — most extensions are optional).
   */
  onHealthCheck?: (
    name: string,
    run: () =>
      | Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }>
      | { ok: boolean; error?: string; detail?: Record<string, unknown> },
    opts?: { critical?: boolean },
  ) => void;

  /**
   * Register a route on the engine's GLOBAL app, outside the extension's
   * `/ext/<name>/` namespace. Use sparingly — most routes should live on
   * the sub-app provided to `register()`. Valid cases:
   *
   *   - Public CDN-style endpoints with stable user-facing URLs
   *     (e.g. `/share/:token` for shared file links).
   *   - User-deployed handlers whose path shape is dictated by the user
   *     (e.g. `/api/fn/:name` for edge functions).
   *
   * Extensions on `mountStrategy: 'subapp'` use this to keep specific
   * routes at fixed root-relative paths even though the rest of the
   * extension lives under `/ext/<name>/`. Public routes are re-registered
   * on each engine rebuild — disabling the extension makes them disappear
   * just like sub-app routes.
   *
   * @example
   *   ctx.registerPublicRoute({
   *     method: 'GET',
   *     path: '/share/:token',
   *     handler: async (c) => { ... },
   *   });
   */
  registerPublicRoute(spec: PublicRouteSpec): void;

  // ─── Engine-internal helpers (for official extensions) ───────────────────────
  // These expose deep engine functionality to first-party extensions.
  // Third-party extensions should rely on the stable API above instead.

  /**
   * Engine-internal helpers. Stable across patch versions but may break across
   * minor versions. First-party extensions only.
   */
  internals: ExtensionInternals<DB>;
}

/**
 * Engine-internal helpers passed via `ctx.internals.*`.
 * Each field is the live engine singleton or function — extensions should never
 * import these directly from `../../../packages/engine/src/...` paths.
 */
export interface ExtensionInternals<DB = unknown> {
  /** Type-safe insert into a dynamic (user-defined) collection table. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  dynamicInsert: (db: any, collection: string, values: Record<string, unknown>) => Promise<unknown>;
  /** Introspect a Postgres schema — returns tables, columns, types, indexes, FKs. */
  introspectSchema: (
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    db: any,
    schemaName?: string,
    excludePatterns?: string[],
    dryRun?: boolean,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  ) => Promise<any[]>;
  /** Run a data-quality scan over a collection. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  runQualityScan: (...args: any[]) => Promise<unknown>;
  /** Invalidate the cached validation rules for a collection. */
  invalidateRulesCache: (collection: string) => void;
  /**
   * Evaluate a user-authored validation expression, safely.
   *
   * `refused` is distinct from `failed` on purpose: an expression the engine
   * declines to run has not passed and has not failed, and a rule editor that
   * reports either would be lying to whoever is writing the rule.
   *
   * Use this instead of `new Function` or `eval`. A Function body closes over
   * the global scope, so an expression stored by any tenant admin could reach
   * `process` and `Bun` from inside the engine process.
   */
  evaluateExpressionRule: (
    expression: string,
    value: unknown,
  ) => { status: 'passed' } | { status: 'failed' } | { status: 'refused'; reason: string };
  /** Vet an expression before storing it. */
  checkValidationExpression: (expression: string) => { ok: true } | { ok: false; reason: string };
  /**
   * Run a callback inside a tenant transaction, outside any request.
   *
   * `ctx.reqDb(c)` covers request handlers. Background work — scheduled tasks,
   * queue workers, fire-and-forget jobs — has no `c` and so had nothing: it ran
   * on the engine's global pool with no tenant context at all. `data/export`
   * and `data/import` documented that in a comment and called the fix a
   * follow-up.
   *
   * The tenant must come from wherever the work was ENQUEUED; a job has no
   * caller to inherit one from. Inside the callback the handle behaves exactly
   * like a request's: the tenant GUC is set and `SET LOCAL ROLE` applied, so
   * the isolation policies bind.
   *
   *     await ctx.internals.withTenantIsolation(tenantId, async (db) => {
   *       await db.selectFrom('zvd_things').selectAll().execute();
   *     });
   */
  withTenantIsolation: <T>(tenantId: string, fn: (db: Kysely<DB>) => Promise<T>) => Promise<T>;

  /**
   * The instance's own read policies, so an extension can honour them.
   *
   * `ctx.db` gives an extension the TENANT boundary — the Postgres policies
   * bind, and rows from another company are unreachable. It gives nothing for
   * the two access rules an operator writes inside a tenant: the RLS rules at
   * `/api/rls`, which hide rows from a user, and the column permissions that
   * hide a field from a role. Those live in the engine and, until now, only the
   * engine could read them.
   *
   * So an extension serving the same data as a core route enforced strictly
   * less, and nothing said so. `data/export` is the worked example: the engine's
   * `/api/export` gained both guards, its own copy kept `selectAll()` inside a
   * tenant transaction, and the Studio calls the extension. The fix was
   * impossible to write on that side — not overlooked, unavailable.
   *
   * Ungated, deliberately. Every other guarded member of this bag grants
   * authority; these only ever remove rows and columns from a result. An
   * extension that cannot call them does not become safer, it becomes the
   * loophole.
   *
   *     const cols = await ctx.internals.getColumnAccess(coll, role);
   *     const q = ctx.internals.applyRlsFilters(base, filters);
   */
  /**
   * Apply field encryption to a value the operator marked `encrypted: true`.
   * No-op when `isEncrypted` is false, when the value is not a string, or when
   * it is already encrypted.
   *
   * Not `encryptSecret`: that is gated behind the `secrets` capability, which
   * also hands over `decryptSecret`. Writing a row correctly should not cost the
   * power to read every stored secret — and that trade is why `data/import`
   * stored marked columns in PLAINTEXT rather than declaring the capability.
   *
   * Throws when `FIELD_ENCRYPTION_KEY` is unset and the field is marked, which
   * is the engine's posture on the same path: a column an operator marked
   * sensitive is not silently downgraded.
   */
  maybeEncrypt: (value: unknown, isEncrypted: boolean) => Promise<unknown>;
  /**
   * The other half. Without it an extension can write a secret it cannot read
   * back, so it stores plaintext instead — which is how a signing secret ends
   * up readable by anyone with database access.
   *
   * Passes through values that do not carry the `enc:v1:` prefix, so adopting
   * encryption on an existing column is safe: rows written before keep working,
   * rows written after are encrypted at rest.
   */
  maybeDecrypt: (value: unknown, isEncrypted: boolean) => Promise<unknown>;
  getRlsFilters: (
    collection: string,
    user: { id: string; email?: string; role: string; rlsBypass?: boolean },
    authType: 'session' | 'api_key',
  ) => Promise<RlsFilter[]>;
  /** Apply what `getRlsFilters` returned to a query builder. */
  applyRlsFilters: <Q>(query: Q, filters: RlsFilter[]) => Q;
  /**
   * Columns this role may not read, and may not write.
   *
   * No db parameter: the host resolves the handle. Column permissions are
   * instance configuration rather than tenant rows, so letting each extension
   * pick a handle would only be a way to get it wrong.
   */
  getColumnAccess: (
    collection: string,
    role: string,
  ) => Promise<{ hidden: Set<string>; readOnly: Set<string> }>;
  /** The Casbin role behind a user — what `getColumnAccess` keys on. */
  resolveUserRole: (user: { id?: string; role?: string }) => Promise<string>;
  /** Is this user an administrator of the current tenant? */
  isTenantAdmin: (userId: string) => Promise<boolean>;
  /**
   * Instance-level admin, as distinct from admin-within-a-tenant.
   *
   * `checkPermission(userId, 'admin', '*')` is TRUE for a delegated tenant
   * owner inside their own domain — the `tenant_owner` policy is `('*','*','*')`
   * there. That is the right answer for tenant-scoped screens and the wrong one
   * for anything that reaches the instance: raw SQL, schema changes, role
   * grants. Use this for those.
   */
  requireInstanceAdmin: (userId: string) => Promise<boolean>;

  /** Run an Edge Function in the sandbox (used by developer/edge-functions). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  runEdgeFunction: (...args: any[]) => Promise<unknown>;
  /** Cross-extension hook registry (e.g. trash purge, scheduled cleanups). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  extensionRegistry: any;
  /** Queue an HTML→PDF render via the worker pool. */
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  /** Synchronous template render with `{{var}}` interpolation. */
  renderTemplate: (template: string, variables: Record<string, unknown>) => string;
  /** Inline HTML→PDF render (blocking). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  generatePDF: (...args: any[]) => Promise<unknown>;
  /** Move a file to the trash bucket (soft delete with TTL). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  moveToTrash: (...args: any[]) => Promise<unknown>;
  /** Schedule async indexing for a newly uploaded file. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  scheduleFileIndexing: (...args: any[]) => Promise<unknown>;
  /** GraphQL DataLoader registry — N+1 query batching. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  DataLoaderRegistry: any;
  /** Validate GraphQL query depth. Returns an error message if too deep, null otherwise. */
  checkQueryDepth: (query: string, maxDepth?: number) => string | null;
  /**
   * Validate GraphQL query width — the sibling guard to `checkQueryDepth`, for
   * queries that are shallow but enormously wide. Returns an error message if
   * too wide, null otherwise.
   *
   * The engine has handed this to extensions since the width guard was added
   * (`lib/extensions/internals.ts`); only this declaration was missing, so
   * `developer/graphql` — the one extension that uses it — has failed typecheck
   * on master while working perfectly at runtime.
   */
  checkQueryWidth: (query: string, maxFields?: number) => string | null;
  /** Enqueue an asynchronous DDL job (Ghost Tables, large alters). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  enqueueDDLJob: (...args: any[]) => Promise<unknown>;
  /**
   * Validate that a URL targets a public, non-internal address (SSRF safety).
   * Synchronous — throws on a blocked URL and returns nothing. Safe to call from
   * a sync context such as a zod `superRefine`. This checks only the literal
   * host text; prefer {@link assertPublicUrl} wherever you can await.
   */
  validatePublicUrl: (url: string) => void;
  /**
   * DNS-aware SSRF check: everything `validatePublicUrl` does, plus rejecting
   * hostnames that RESOLVE into private space (an attacker-owned name with an A
   * record pointing at cloud metadata). MUST be awaited.
   */
  assertPublicUrl: (url: string) => Promise<void>;
  /**
   * `fetch` with the SSRF guard applied where it has to be.
   *
   * Validating a URL before calling `fetch` is not enough on its own: fetch
   * follows redirects, so a public host answering 302 to 169.254.169.254
   * walks past a check performed on the original URL. This re-validates
   * every redirect target, under a hop limit. Prefer it over `fetch` for
   * any URL a user or a stored record can influence.
   */
  safeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /**
   * SSRF guard for an admin-configured endpoint that is ALLOWED to be
   * self-hosted (local Ollama on `http://localhost:11434`, an internal
   * Meilisearch, on-prem object storage). Permits private ranges but rejects
   * cloud-metadata hosts such as 169.254.169.254. Use this — NOT
   * `validatePublicUrl` / `assertPublicUrl` — for provider "base URL" settings,
   * otherwise every self-hosted deployment breaks. Synchronous; throws when
   * the URL is blocked.
   */
  assertNonMetadataUrl: (url: string, label?: string) => void;
  /** Extract plain text from an uploaded file (PDF/DOCX/etc.) for AI indexing. */
  extractTextFromFile: (
    buffer: ArrayBuffer | Buffer | Uint8Array,
    mimeType: string,
  ) => Promise<string>;
  /** Send an in-app notification to a user (writes to zv_notifications system table). */
  sendNotification: (
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    db: any,
    input: { user_id: string; type?: string; title: string; message?: string; data?: unknown },
  ) => Promise<void>;
  /**
   * Create a Better-Auth session for an already-authenticated user (SSO bridge).
   *
   * SAML / LDAP / OIDC extensions verify the user out-of-band and need a
   * Better-Auth session that `auth.api.getSession({ headers })` will accept.
   * This helper handles the exact column shape (camelCase) of the `session`
   * table AND the signed-cookie format Better-Auth expects, so SSO providers
   * don't have to inline Better-Auth internals.
   *
   * Returns the `Set-Cookie` header value — the route handler attaches it to
   * its Response. Pass `crossDomain: true` to emit `SameSite=None; Secure`
   * (needed when Studio runs on a different origin than the engine).
   */
  createBetterAuthSession: (
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    db: any,
    userId: string,
    opts?: {
      ipAddress?: string;
      userAgent?: string;
      ttlSeconds?: number;
      crossDomain?: boolean;
    },
  ) => Promise<{ token: string; setCookie: string }>;
  /**
   * Encrypt a secret (LDAP bind passwords, third-party API keys, …) with
   * the engine's AES-256-GCM field encryption key (FIELD_ENCRYPTION_KEY).
   * Output is prefixed with `enc:v1:`, so calling this on an already-
   * encrypted value is a no-op. Throws if FIELD_ENCRYPTION_KEY is unset;
   * extensions should refuse the write rather than persist plaintext.
   */
  encryptSecret: (plaintext: string) => Promise<string>;
  /**
   * Reverse of `encryptSecret`. Returns the plaintext if the value has
   * the `enc:v1:` prefix; otherwise returns the value as-is so reads of
   * legacy unencrypted rows still work during a rolling encryption rollout.
   */
  decryptSecret: (value: string) => Promise<string>;
}

/**
 * Entity-access scope handed to each extension via `ctx.entityAccess`.
 *
 * Use this for row-level authorization that cannot be expressed via roles
 * alone: "only the owner can view this", "drafts editable only by author",
 * "manager can approve only their direct reports", etc.
 *
 * Semantics: first `deny` wins. If no checks are registered for a table,
 * access is allowed (no extension cares about it).
 *
 * @example
 *   ctx.entityAccess.register({
 *     table: 'zvd_payroll',
 *     async check(record, user, op) {
 *       if (user.roles.includes('hr')) return 'allow';
 *       if (op === 'view' && record.user_id === user.id) return 'allow';
 *       return 'deny';
 *     },
 *   });
 *
 * Scoped to the registering extension — automatically cleaned up on unload.
 */
export interface EntityAccessScope {
  register(def: {
    table: string;
    check: (
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      record: any,
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      user: any,
      op: 'view' | 'update' | 'delete',
    ) => ('allow' | 'deny') | Promise<'allow' | 'deny'>;
  }): void;
  list(): Array<{ table: string }>;
  unregisterAll(): void;
}

/**
 * Query-alter scope handed to each extension via `ctx.queryAlter`.
 *
 * Each call to `register({ table, alter })` is automatically tagged with the
 * registering extension's name so it can be cleaned up on unload — extensions
 * don't manage that lifecycle themselves.
 */
export interface QueryAlterScope {
  register(def: {
    /** Table name to attach the alter to (typically `zvd_<collection>`). */
    table: string;
    /**
     * Mutates the Kysely query builder before execution. Must return a chained
     * builder. `qb` and `user` are typed `any` in the SDK so extensions don't
     * need to depend on engine internals; cast as needed.
     */

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    alter: (qb: any, user: any) => any;
  }): void;
  list(): Array<{ table: string }>;
  unregisterAll(): void;
}

/**
 * Inter-extension service registry.
 *
 * Extensions publish services here for other extensions to consume — a Drupal-style
 * services container. Services are keyed by string names (e.g. `'ai.providers'`,
 * `'crm.contacts.lookup'`). Consumers should treat `get()` returning `null` as a
 * recoverable signal (the providing extension is not active) and either skip the
 * feature or surface a clear error to the user.
 *
 * Extensions MUST NOT directly import from other extensions — communication goes
 * exclusively through this registry.
 *
 * The instance passed to each extension via `ctx.services` is **scoped to that
 * extension** — anything `register()`-ed through it is automatically attributed
 * to the extension and gets cleaned up on unload (disable / hot-reload).
 * `register()` is idempotent within a scope (replaces on duplicate), so an
 * extension's `register()` can safely run multiple times during hot-reload.
 */
export interface ServiceRegistry {
  /**
   * Publish a service under a name.
   * Idempotent: re-registering the same name from the same extension replaces.
   * Throws if a different extension already owns that name.
   */
  register<T = unknown>(name: string, value: T): void;
  /** Remove a service this extension previously registered. No-op if not owned. */
  unregister(name: string): void;
  /** Get a service. Returns `null` if not registered. */
  get<T = unknown>(name: string): T | null;
  /** Check if a service is registered. */
  has(name: string): boolean;
  /**
   * Wait for a service to be registered. Resolves immediately if already there.
   * Rejects after `timeoutMs` (default 30s) if never registered.
   */
  waitFor<T = unknown>(name: string, timeoutMs?: number): Promise<T>;
  /** List all registered service names — useful for debugging. */
  list(): string[];
}

/**
 * Pre-write hook payloads.
 *
 * Subscribe via `ctx.events.onBefore('record.beforeInsert', handler)`. The
 * handler is async and receives a mutable payload. Call:
 *   - `payload.mutate({ ... })` to merge fields into the in-flight write —
 *     subsequent handlers and the data layer see the patched values.
 *   - `payload.abort('reason')` to reject the write — the HTTP response
 *     becomes 422 with code `EXT_HOOK_ABORTED` and the reason in the body.
 *
 * Hooks run sequentially in registration order. Throwing a non-abort error
 * surfaces as 500.
 */
export interface BeforeInsertPayload {
  collection: string;
  data: Record<string, unknown>;
  userId: string;
  abort(reason: string): never;
  mutate(patch: Record<string, unknown>): void;
}

export interface BeforeUpdatePayload {
  collection: string;
  id: string;
  before: Record<string, unknown>;
  patch: Record<string, unknown>;
  userId: string;
  abort(reason: string): never;
  mutate(patch: Record<string, unknown>): void;
}

export interface BeforeDeletePayload {
  collection: string;
  id: string;
  record: Record<string, unknown>;
  userId: string;
  abort(reason: string): never;
}

/**
 * Native scheduled task. Extensions declare these via `ZveltioExtension.schedules()`.
 *
 * Specify exactly ONE timing field:
 *   - `intervalMs`: re-run every N milliseconds.
 *   - `at`: run once a day at `{ hour, minute }` (server's local timezone).
 *   - `cron`: reserved for future cron-expression support; currently logged
 *     as unsupported and the schedule is skipped.
 *
 * Every invocation persists to the `zv_extension_schedule_runs` table with
 * status `running` → (`ok` | `failed` | `dlq`). `failed` rows trigger another
 * attempt up to `retry.maxAttempts`; the final failed attempt is recorded as
 * `dlq` (dead letter — admin can replay manually).
 *
 * Cross-instance: NOT yet coordinated. Multiple engine replicas will each run
 * the same schedule until distributed locking lands.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export interface ExtensionSchedule<DB = any> {
  /** Stable name, unique within this extension. Used as the persistence key. */
  name: string;
  intervalMs?: number;
  at?: { hour: number; minute: number };
  cron?: string;
  /** Async work to perform. `runId` is the row id in zv_extension_schedule_runs. */
  handler: (ctx: ExtensionContext<DB>, runId: string) => Promise<void>;
  retry?: { maxAttempts?: number; backoffMs?: number };
  /** Reserved — single-engine assumption today. Documented behaviour. */
  singleton?: boolean;
}

/**
 * Spec for a route registered on the engine's global app via
 * `ctx.registerPublicRoute()`. See the `registerPublicRoute` field on
 * `ExtensionContext` for usage guidance.
 */
export interface PublicRouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';
  /** Absolute path on the global app, e.g. `'/share/:token'`. */
  path: string;
  /** Hono handler — receives the Context, returns a Response (or via c.json). */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  handler: (c: any) => any;
}

/**
 * Mount strategy for the extension's Hono routes (S3-01).
 *
 * - `'global'` (default, legacy): the `register(app, ctx)` callback receives
 *   the engine's global Hono app. Extension owns full URL paths and typically
 *   mounts under `/api/<feature>`. Routes cannot be cleanly de-registered at
 *   runtime — disabling the extension requires an app rebuild.
 *
 * - `'subapp'`: the `register(subApp, ctx)` callback receives a per-extension
 *   Hono instance. The engine mounts it at `/ext/<extension-name>` so the
 *   extension's routes appear under that prefix. Disable/enable is cheap
 *   (next rebuild drops the sub-app); no cross-extension URL collisions.
 *   New extensions should use this. Migrating an existing extension is
 *   lock-step with updating its Studio bundle URL calls.
 */
export type MountStrategy = 'global' | 'subapp';

/** The interface every Zveltio extension must implement. */
/**
 * The interface every Zveltio extension implements.
 *
 * @example Untyped (legacy / new extensions before codegen)
 *   const ext: ZveltioExtension = { ... }
 *
 * @example Typed via codegen (S4-01 + S4-02)
 *   import type { ExtensionSchema as DB } from './.zveltio/db.js';
 *   const ext: ZveltioExtension<DB> = {
 *     async register(app, ctx) {
 *       // ctx.db is Kysely<DB> — full autocomplete on table + column names
 *       const items = await ctx.db.selectFrom('zv_my_items').selectAll().execute();
 *     }
 *   };
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export interface ZveltioExtension<DB = any> {
  /** Unique name — must match manifest.json `name` exactly (e.g. `'hr/employees'`). */
  name: string;
  /** Category shown in the marketplace (e.g. `'hr'`, `'finance'`, `'content'`). */
  category: string;
  /**
   * How the engine mounts the extension's routes. Defaults to `'global'` for
   * backward compatibility with existing extensions. New extensions should
   * declare `'subapp'`. See `MountStrategy` for details.
   */
  mountStrategy?: MountStrategy;
  /**
   * Called once when the extension is activated.
   * Register Hono routes, subscribe to events, etc.
   */
  register: (app: Hono, ctx: ExtensionContext<DB>) => Promise<void>;
  /** Register custom Studio field types contributed by this extension. */
  registerFieldTypes?: (registry: FieldTypeRegistryAPI) => void;
  /** Return absolute paths to SQL migration files, run in order on first activation. */
  getMigrations?: () => string[];
  /**
   * Return the list of scheduled tasks. Called once after `register()`. The
   * engine's cron runner picks them up and starts polling.
   */
  schedules?: () => ExtensionSchedule<DB>[];
  /**
   * Called when the extension is disabled or the server shuts down.
   * Close database connections, clear timers, etc.
   * Note: Hono routes cannot be de-registered at runtime — they persist until restart.
   */
  cleanup?: () => Promise<void>;
}

// ─── Studio extension API (available via window.__zveltio in IIFE bundles) ───

export interface StudioExtensionAPI {
  registerRoute(route: StudioRoute): void;
  registerFieldType(ft: StudioFieldType): void;
  registerAssetPreview(handler: AssetPreviewHandler): void;
  /**
   * Register a component into a named slot in core Studio (S3-03).
   * Slot names are stable strings declared by core (e.g. `dashboard.widgets`,
   * `collections.list.toolbar`). See the developer guide for the full list.
   */
  registerSlot(name: string, contribution: SlotContribution): void;
  /**
   * Drupal-style `hook_form_alter` for Studio forms (S3-02). The hook
   * receives a `form` object with `addField`, `hideField`, `reorder`,
   * `addValidator`. Form IDs are stable strings (e.g. `core:user-edit`,
   * `collection:zvd_contacts:edit`).
   */
  registerFormAlter(formId: string, hook: FormAlterHook): void;
  engineUrl: string;
}

/** S3-03: a single slot contribution. */
export interface SlotContribution {
  /** Svelte component to render. */
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  component: any;
  /**
   * Lower runs first. Default 100. Two contributions with the same
   * priority render in registration order.
   */
  priority?: number;
  /**
   * Optional predicate. If returns false, the contribution is skipped.
   * `ctx` carries whatever the slot host passes (typically `{ user }`).
   */
  visible?: (ctx: Record<string, unknown>) => boolean;
  /** Optional props passed to the component. */
  props?: Record<string, unknown>;
}

/** S3-02: signature of a form-alter hook. */
export type FormAlterHook = (form: FormAlterAPI, ctx: Record<string, unknown>) => void;

/** S3-02: the surface form-alter hooks operate on. */
export interface FormAlterAPI {
  addField(spec: { after?: string; before?: string; field: FormField }): void;
  hideField(name: string): void;
  reorder(order: string[]): void;
  addValidator(fieldName: string, validator: (value: unknown) => string | null): void;
  readonly fields: ReadonlyArray<FormField>;
}

/** S3-02: minimal form schema shape consumed by alters + renderers. */
export interface FormSchema {
  /** Stable form id; matched by `registerFormAlter`. */
  id: string;
  /** Fields in render order. */
  fields: FormField[];
  /** Free-form metadata renderers may inspect. */
  meta?: Record<string, unknown>;
}

/** S3-02: a single form field as seen by alters. */
export interface FormField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  hidden?: boolean;
  options?: Array<string | { value: string; label: string }>;
  validators?: Array<(value: unknown) => string | null>;
  /** Anything else the renderer needs. Renderers + alters share this loosely. */
  [k: string]: unknown;
}

export interface StudioRoute {
  path: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  component: any; // Svelte component
  /** Sidebar label. Optional — when omitted, the route exists for routing
   *  but doesn't surface in the nav (use together with `hidden` for purely
   *  programmatic child routes). */
  label?: string;
  icon?: string;
  /** Sidebar group key. Optional; extensions that don't care about
   *  grouping can leave it off. */
  category?: string;
  children?: StudioRoute[];
  /** Display under a custom heading instead of the default category. Used
   *  by extensions that want a localized group label (e.g. "Trasabilitate"). */
  parent?: string;
  /** Hide from the sidebar even when label is set. Useful for detail
   *  pages (`/items/:id`) that are reachable via in-app navigation. */
  hidden?: boolean;
}

export interface StudioFieldType {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  editor: () => Promise<{ default: any }>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  display: () => Promise<{ default: any }>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  filter?: () => Promise<{ default: any }>;
}

export interface AssetPreviewHandler {
  match: (asset: { url: string; name?: string; mimeType?: string }) => boolean;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  component: any; // Svelte component
}

export type { Hono };
