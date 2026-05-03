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
}

/** Context injected into every extension's register() call. */
export interface ExtensionContext {
  /** Kysely database instance (restricted — cannot query zv_* system tables). */
  db: any;
  /** Better-Auth instance. */
  auth: any;
  /** Field type registry — register custom field types here. */
  fieldTypeRegistry: FieldTypeRegistryAPI;
  /** Typed event bus — subscribe to record lifecycle events (insert/update/delete). */
  events: any;
  /** Check if a user has permission for a resource/action. */
  checkPermission?: (userId: string, resource: string, action: string) => Promise<boolean>;
  /** Get all roles assigned to a user. */
  getUserRoles?: (userId: string) => Promise<string[]>;
  /** DDLManager — schema migration utilities (Ghost Tables, zero-downtime DDL). */
  DDLManager?: any;
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
