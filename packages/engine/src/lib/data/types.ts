/**
 * Boundary types for the CRUD data path (H-05 split of `routes/data.ts`).
 *
 * The data path handles user-created ("dynamic") collections whose columns are
 * only known at runtime, so rows cannot be statically typed against a Kysely
 * schema. Instead of letting them flow as untyped `any`, we model them as
 * `DynamicRow` (a JSON object) and validate at the PARSE boundary (field-type
 * registry) — past that boundary no casts are needed.
 *
 * These types are shared by `shape.ts`, `query-parse.ts`, `write-pipeline.ts`
 * and `routes/data.ts`. Extracting them here (rather than into one of the
 * helper modules) breaks the helper↔routes import cycle: every module imports
 * types from here, and nothing here imports from them.
 */

/** A JSON-serializable value — the leaf type for every dynamic row field. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A row from a dynamic (user-created) collection. Columns are runtime-defined,
 * so the row is a JSON object keyed by column name. */
export type DynamicRow = Record<string, JsonValue>;

/** Minimal user shape attached to every authenticated request context. */
export interface RequestUser {
  id: string;
  name: string;
  role: string;
  /** Present only for API-key auth — collection/action scopes */
  scopes?: unknown;
  /** Email — present for session auth */
  email?: string;
}

/** One field in a collection definition (a subset of `FieldConfig`). Dynamic
 * collections are stored as JSON, so field shapes are validated by the field-type
 * registry, not the type system — this captures only what the data path reads. */
export interface CollectionField {
  name: string;
  type: string;
  encrypted?: boolean;
  options?: { related_collection?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** The runtime collection definition returned by `DDLManager.getCollection`.
 * `fields` may arrive as a JSON string (raw DB row) or an already-parsed array. */
export interface CollectionDef {
  name?: string;
  fields?: CollectionField[] | string;
  source_type?: string;
  virtual_config?: unknown;
  has_trgm?: boolean;
  [key: string]: unknown;
}

/** Metadata about one `?expand=field` relation to hydrate. */
export interface ExpandTarget {
  field: string;
  targetTable: string;
  targetCollection: string;
}
