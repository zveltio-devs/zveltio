// Shared shapes for the collections detail components (RecordDrawer,
// CollectionDataTable, CollectionSchemaPanel). These describe the dynamic
// collection metadata the API returns; the index signatures keep them
// permissive (extra keys are `unknown`) so we get real types on the known
// fields without pretending the payload is fully closed. Replaces the repeated
// `any` prop/state annotations that the extraction would otherwise duplicate.

export interface FieldOptions {
  related_collection?: string;
  [key: string]: unknown;
}

/** A custom or system field in a collection's schema. */
export interface CollectionField {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  is_system?: boolean;
  options?: FieldOptions;
  [key: string]: unknown;
}

/** A relation row from `/api/relations`. */
export interface Relation {
  id: string;
  name: string;
  type: string;
  source_collection?: string;
  source_field?: string;
  target_collection: string;
  target_field?: string;
  on_delete?: string;
  junction_table?: string;
  [key: string]: unknown;
}

/** A collection summary (from `collectionsApi.list()`), enough to resolve
 * relation targets. `fields` may arrive as a JSON string or a parsed array. */
export interface CollectionSummary {
  name: string;
  display_name?: string;
  fields?: CollectionField[] | string;
  [key: string]: unknown;
}

/** A data row of a collection — a stable `id` plus arbitrary column values. */
export interface CollectionRecord {
  id: string;
  [key: string]: unknown;
}

/** A field-type registry entry (from the field-types API) — the palette of
 * types the add-field form offers. Permissive: only the display keys are known. */
export interface FieldType {
  type: string;
  label?: string;
  [key: string]: unknown;
}
