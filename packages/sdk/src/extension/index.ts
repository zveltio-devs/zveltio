import type { Hono } from 'hono';

// ─────────────────────────────────────────────────────────────────────────────
// Zveltio Extension API — public types for extension authors
//
// This is the single source of truth for extension types.
// Both the engine (which loads extensions) and extension authors (who implement
// them) use these interfaces.  Concrete engine-internal types (Database, EventBus,
// DDLManager) are intentionally typed as `any` here so extensions compile without
// depending on engine internals.
// ─────────────────────────────────────────────────────────────────────────────

export interface FieldTypeRegistryAPI {
  register(definition: any): void;
  get(type: string): any;
  has(type: string): boolean;
  list(): string[];
  /** Coerce a value FROM the database representation INTO its TS shape. */
  deserialize(type: string, value: any): any;
  /** Coerce a value FROM its TS shape INTO the database representation. */
  serialize(type: string, value: any): any;
}

/** Context injected into every extension's register() call. */
export interface ExtensionContext {
  // ─── Stable public API ───────────────────────────────────────────────────────

  /** Kysely database instance (restricted — cannot query zv_* system tables). */
  db: any;
  /** Better-Auth instance — use `ctx.auth.api.getSession({ headers })` in route handlers. */
  auth: any;
  /** Field type registry — register custom field types here. */
  fieldTypeRegistry: FieldTypeRegistryAPI;
  /** Typed event bus — subscribe to record lifecycle events (insert/update/delete). */
  events: any;
  /** Check if a user has permission for a resource/action. */
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  /** Get all roles assigned to a user. */
  getUserRoles: (userId: string) => Promise<string[]>;
  /** DDLManager class — schema migration utilities (Ghost Tables, zero-downtime DDL). */
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

  // ─── Engine-internal helpers (for official extensions) ───────────────────────
  // These expose deep engine functionality to first-party extensions.
  // Third-party extensions should rely on the stable API above instead.

  /**
   * Engine-internal helpers. Stable across patch versions but may break across
   * minor versions. First-party extensions only.
   */
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers passed via `ctx.internals.*`.
 * Each field is the live engine singleton or function — extensions should never
 * import these directly from `../../../packages/engine/src/...` paths.
 */
export interface ExtensionInternals {
  /** Type-safe insert into a dynamic (user-defined) collection table. */
  dynamicInsert: (db: any, collection: string, values: Record<string, unknown>) => Promise<unknown>;
  /** Introspect a Postgres schema — returns tables, columns, types, indexes, FKs. */
  introspectSchema: (
    db: any,
    schemaName?: string,
    excludePatterns?: string[],
    dryRun?: boolean,
  ) => Promise<any[]>;
  /** Run a data-quality scan over a collection. */
  runQualityScan: (...args: any[]) => Promise<unknown>;
  /** Invalidate the cached validation rules for a collection. */
  invalidateRulesCache: (collection: string) => void;
  /** Run an Edge Function in the sandbox (used by developer/edge-functions). */
  runEdgeFunction: (...args: any[]) => Promise<unknown>;
  /** Cross-extension hook registry (e.g. trash purge, scheduled cleanups). */
  extensionRegistry: any;
  /** Queue an HTML→PDF render via the worker pool. */
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  /** Synchronous template render with `{{var}}` interpolation. */
  renderTemplate: (template: string, variables: Record<string, unknown>) => string;
  /** Inline HTML→PDF render (blocking). */
  generatePDF: (...args: any[]) => Promise<unknown>;
  /** Move a file to the trash bucket (soft delete with TTL). */
  moveToTrash: (...args: any[]) => Promise<unknown>;
  /** Schedule async indexing for a newly uploaded file. */
  scheduleFileIndexing: (...args: any[]) => Promise<unknown>;
  /** GraphQL DataLoader registry — N+1 query batching. */
  DataLoaderRegistry: any;
  /** Validate GraphQL query depth. Returns an error message if too deep, null otherwise. */
  checkQueryDepth: (query: string, maxDepth?: number) => string | null;
  /** Enqueue an asynchronous DDL job (Ghost Tables, large alters). */
  enqueueDDLJob: (...args: any[]) => Promise<unknown>;
  /** Validate that a URL targets a public, non-internal address (SSRF safety). */
  validatePublicUrl: (url: string) => Promise<URL>;
  /** Extract plain text from an uploaded file (PDF/DOCX/etc.) for AI indexing. */
  extractTextFromFile: (buffer: ArrayBuffer | Buffer | Uint8Array, mimeType: string) => Promise<string>;
  /** Send an in-app notification to a user (writes to zv_notifications system table). */
  sendNotification: (db: any, input: { user_id: string; type?: string; title: string; message?: string; data?: unknown }) => Promise<void>;
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

/** The interface every Zveltio extension must implement. */
export interface ZveltioExtension {
  /** Unique name — must match manifest.json `name` exactly (e.g. `'hr/employees'`). */
  name: string;
  /** Category shown in the marketplace (e.g. `'hr'`, `'finance'`, `'content'`). */
  category: string;
  /**
   * Called once when the extension is activated.
   * Register Hono routes, subscribe to events, etc.
   */
  register: (app: Hono, ctx: ExtensionContext) => Promise<void>;
  /** Register custom Studio field types contributed by this extension. */
  registerFieldTypes?: (registry: FieldTypeRegistryAPI) => void;
  /** Return absolute paths to SQL migration files, run in order on first activation. */
  getMigrations?: () => string[];
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
  engineUrl: string;
}

export interface StudioRoute {
  path: string;
  component: any; // Svelte component
  label: string;
  icon: string;
  category: string;
  children?: StudioRoute[];
}

export interface StudioFieldType {
  type: string;
  editor: () => Promise<{ default: any }>;
  display: () => Promise<{ default: any }>;
  filter?: () => Promise<{ default: any }>;
}

export interface AssetPreviewHandler {
  match: (asset: { url: string; name?: string; mimeType?: string }) => boolean;
  component: any; // Svelte component
}

export type { Hono };
