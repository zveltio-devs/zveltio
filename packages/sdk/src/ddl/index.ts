/**
 * DDL types + DDLManager interface for extension authors (S4-08).
 *
 * Replaces the previous tsconfig path-alias `@zveltio/engine-ddl` that
 * pointed extensions directly at `engine/src/lib/ddl-manager.ts`. That
 * alias broke the SDK ↔ engine boundary: extensions had a hard
 * structural dependency on engine internals, and `bun extension publish`
 * couldn't bundle them cleanly.
 *
 * What lives here:
 *   - Pure TYPE definitions for collections, fields, and relations.
 *   - The `DDLManager` INTERFACE — the subset of the engine's
 *     DDLManager class that extensions actually call via `ctx.DDLManager`.
 *
 * What does NOT live here (intentionally):
 *   - The runtime DDLManager class itself. It depends on
 *     `fieldTypeRegistry`, lock-timeout transactions, and other
 *     engine-internal plumbing. The engine continues to own the
 *     implementation and hands an instance into every extension via
 *     `ctx.DDLManager`.
 *
 * Usage in an extension:
 *   import type { DDLManager, CollectionDefinition } from '@zveltio/sdk/ddl';
 *
 *   export const ext: ZveltioExtension = {
 *     async register(_app, ctx) {
 *       const ddl: DDLManager = ctx.DDLManager;
 *       const col = await ddl.getCollection(ctx.db, 'contacts');
 *       // ...
 *     },
 *   };
 */

// ── Field + relation types ──────────────────────────────────────────────────

/**
 * Definition of one field in a collection. Mirrors the Zod schema in the
 * engine's ddl-manager.ts but as a plain TypeScript interface so the SDK
 * has no Zod dependency.
 */
export interface FieldDefinition {
  /** Lowercase, snake_case identifier. PostgreSQL column name. */
  name: string;
  /**
   * Field type id. Built-ins: `text`, `number`, `boolean`, `date`,
   * `datetime`, `json`, `uuid`, `email`, `url`, `richtext`, `m2o`,
   * `m2m`, `o2m`, `reference`, `select`, `multi-select`, `relation`,
   * `geolocation`, etc. Extensions can register custom types via
   * `ctx.fieldTypeRegistry`.
   */
  type: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  /** Default value for new rows. Type depends on `type`. */
  defaultValue?: unknown;
  /** Type-specific options. Shape depends on `type` — see field-type docs. */
  options?: Record<string, string | number | boolean | null | unknown[]>;
  label?: string;
  description?: string;
  /** Store the field's value encrypted at rest (AES-256-GCM). */
  encrypted?: boolean;
}

/**
 * A collection definition — the unit DDL methods operate on. `name`
 * becomes the suffix of the underlying PG table (`zvd_<name>`).
 */
export interface CollectionDefinition {
  /** Lowercase, snake_case. Max 63 chars (PG identifier limit). */
  name: string;
  displayName?: string;
  icon?: string;
  /** Which zone the collection's records belong to. */
  routeGroup?: 'public' | 'partners' | 'private' | 'admin';
  /** When true, RLS policies + row ownership are enforced for this table. */
  isPermissioned?: boolean;
  sort?: number;
  /** At least one field; required by createCollection. */
  fields: FieldDefinition[];
  description?: string;
  singularName?: string;
  aiSearchEnabled?: boolean;
  aiSearchField?: string | null;
  /** True for collections owned by an extension's migrations
   *  (i.e. ones Studio should not let users alter). */
  isManaged?: boolean;
  isSystem?: boolean;
  schemaLocked?: boolean;
}

/** A row from `zv_collections` / `getCollection` / `getCollections`. The
 *  exact shape is engine-internal; this interface only fixes the fields
 *  extensions are documented to read. Treat unknown keys as best-effort. */
export interface CollectionRecord {
  id?: string;
  name: string;
  displayName?: string;
  fields?: FieldDefinition[];
  routeGroup?: string;
  isPermissioned?: boolean;
  isManaged?: boolean;
  isSystem?: boolean;
  schemaLocked?: boolean;
  [k: string]: unknown;
}

// ── Database alias ──────────────────────────────────────────────────────────
//
// DDLManager methods take a `db` argument. SDK can't import the engine's
// concrete Database type without dragging engine plumbing along, so we
// alias to Kysely<any> here — same runtime, same call shape, just looser
// typing. Extensions calling through `ctx.DDLManager` can pass `ctx.db`
// directly; the runtime instance handles the rest.

import type { Kysely } from 'kysely';
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export type DDLManagerDb = Kysely<any>;

// ── DDLManager interface ────────────────────────────────────────────────────

/**
 * Subset of `DDLManager` available to extensions via `ctx.DDLManager`.
 *
 * The engine ships the implementation as a class with `static` methods.
 * From an extension's perspective they're indistinguishable from instance
 * methods, hence this interface uses the call shape (no `this` requirement).
 *
 * Stability note: this is part of the v1.0 extension SDK contract. New
 * methods may be added; existing signatures will not change in a breaking
 * way without a major version bump.
 */
export interface DDLManager {
  /** Translate a logical collection name to its PG table (`zvd_<name>`). */
  getTableName(collectionName: string): string;

  /** Invalidate the in-engine collection cache. Pass a name to scope the
   *  invalidation, or omit to flush everything. */
  invalidateCache(name?: string): void;

  /** True when `zvd_<collectionName>` exists in the public schema. */
  tableExists(db: DDLManagerDb, collectionName: string): Promise<boolean>;

  /** Create a new collection + its underlying table + indices. Throws if
   *  the collection already exists. */
  createCollection(db: DDLManagerDb, definition: CollectionDefinition): Promise<void>;

  /** Drop a collection. Refuses by default if any table references it via
   *  FK — set `force: true` to cascade. */
  dropCollection(db: DDLManagerDb, name: string, opts?: { force?: boolean }): Promise<void>;

  /** Add a single field to an existing collection. */
  addField(db: DDLManagerDb, collectionName: string, field: FieldDefinition): Promise<void>;

  /** Remove a single field. Fails if any zvd_* row still has a non-null
   *  value unless the underlying field type allows DROP COLUMN. */
  removeField(db: DDLManagerDb, collectionName: string, fieldName: string): Promise<void>;

  /** List every collection registered in `zv_collections`. */
  getCollections(db: DDLManagerDb): Promise<CollectionRecord[]>;

  /** Read a single collection by name. Returns `null` when missing. */
  getCollection(db: DDLManagerDb, name: string): Promise<CollectionRecord | null>;

  /** Update display-only metadata (label, description, icon, sort, etc.). */
  updateCollectionMetadata(
    db: DDLManagerDb,
    name: string,
    metadata: Partial<CollectionDefinition>,
  ): Promise<void>;

  /** Introspect the live PG table and return its field configs. Useful for
   *  extensions that auto-discover schema changes. */
  introspectTable(db: DDLManagerDb, collectionName: string): Promise<FieldDefinition[]>;

  /** Re-read PG and write the result back to `zv_collections.fields`. Returns
   *  the number of changes detected. */
  syncFieldsFromDB(db: DDLManagerDb, collectionName: string): Promise<number>;

  /** Render the SQL that `createCollection` would emit, without running it. */
  previewCollection(definition: CollectionDefinition): Promise<{ sql: string[] }>;
}
