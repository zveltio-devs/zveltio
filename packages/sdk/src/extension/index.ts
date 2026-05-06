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
  /** AI provider manager — embeddings, completions, tool use across providers. */
  aiProviderManager: any;
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
