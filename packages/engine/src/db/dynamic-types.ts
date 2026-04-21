/**
 * Runtime types for user-defined (dynamic) collections.
 *
 * Kysely's type system is built for statically-known schemas. Dynamic
 * collections are created at runtime, so we can't generate static types
 * for them. These types give us a safe, documented escape hatch instead
 * of scattering `as any` throughout route handlers.
 */

/** A single row from any user-created collection table. */
export type DynamicRecord = {
  id: string;
  created_at: Date | string;
  updated_at: Date | string;
  status?: string;
  created_by?: string | null;
  updated_by?: string | null;
  [field: string]: unknown;
};

/** Kysely query builder for a dynamic table (type-erased). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DynamicDB = any;

/** Result of a dynamic SELECT with total count. */
export interface DynamicQueryResult {
  records: DynamicRecord[];
  total: number;
}
