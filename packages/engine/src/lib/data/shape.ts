/**
 * Response shaping for the CRUD data path (H-05 split of `routes/data.ts`).
 *
 * Turns raw DB rows into API payloads: field serialization via the field-type
 * registry, numeric coercion, internal-column stripping, `?expand=` relation
 * hydration, and ETag computation. Every branch, string and side effect is
 * byte-identical to the pre-split inline helpers — zero behaviour change.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../ddl-manager.js';
import { fieldTypeRegistry } from '../field-type-registry.js';
import { maybeDecrypt } from '../field-crypto.js';
import type {
  CollectionDef,
  CollectionField,
  DynamicRow,
  ExpandTarget,
  JsonValue,
} from './types.js';

/** Internal columns that are operational, not user data. They leak into API
 * responses by default because Kysely returns the full row; strip them unless
 * the caller explicitly opts in with ?include_internal=1. */
const INTERNAL_COLUMNS = new Set(['search_vector', 'search_text']);

/** Cast database-side numeric strings back to JS numbers when the schema says
 * the field is numeric. Postgres `numeric/decimal` come back as strings via
 * Bun.SQL — clients shouldn't have to remember which fields to coerce. */
const NUMERIC_FIELD_TYPES = new Set([
  'number',
  'integer',
  'int',
  'bigint',
  'smallint',
  'float',
  'double',
  'decimal',
]);

/** Normalize a collection definition's `fields` (which may be a JSON string or
 * an already-parsed array) into a typed array. */
export function normalizeFields(
  collectionDef: CollectionDef | null | undefined,
): CollectionField[] {
  const raw = collectionDef?.fields;
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CollectionField[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

/** Serialize a record's field values using the field-type registry. */
export async function serializeRecord(
  record: DynamicRow,
  collectionDef: CollectionDef | null | undefined,
): Promise<DynamicRow> {
  const fields = normalizeFields(collectionDef);
  if (fields.length === 0) {
    const out = { ...record };
    for (const k of INTERNAL_COLUMNS) delete out[k];
    return out;
  }
  const result: DynamicRow = { ...record };
  for (const field of fields) {
    if (result[field.name] !== undefined && result[field.name] !== null) {
      if (field.encrypted) {
        result[field.name] = (await maybeDecrypt(result[field.name] as string, true)) as JsonValue;
      }
      result[field.name] = fieldTypeRegistry.serialize(field.type, result[field.name]) as JsonValue;
      // Numeric coercion: Postgres returns numeric/decimal as string. Cast back
      // to number so frontends can sort/format without type tricks.
      if (NUMERIC_FIELD_TYPES.has(field.type) && typeof result[field.name] === 'string') {
        const n = Number(result[field.name]);
        if (Number.isFinite(n)) result[field.name] = n;
      }
    }
  }
  // Strip internal/operational columns from public payloads.
  for (const k of INTERNAL_COLUMNS) delete result[k];
  return result;
}

/** Resolve `?expand=field1,field2` for a collection: returns metadata about
 * which m2o fields the caller wants hydrated and the target collection for each. */
export async function resolveExpand(
  _db: Database,
  collectionDef: CollectionDef | null | undefined,
  expandParam: string | undefined,
): Promise<ExpandTarget[]> {
  const fields = normalizeFields(collectionDef);
  if (!expandParam || fields.length === 0) return [];
  const want = new Set(
    expandParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (want.size === 0) return [];

  const out: ExpandTarget[] = [];
  for (const f of fields) {
    if (!want.has(f.name)) continue;
    if ((f.type !== 'm2o' && f.type !== 'reference') || !f.options?.related_collection) continue;
    out.push({
      field: f.name,
      targetCollection: f.options.related_collection,
      targetTable: DDLManager.getTableName(f.options.related_collection),
    });
  }
  return out;
}

/** Fill an `_expanded` map on each record by fetching referenced rows in one
 * query per relation. Adds {field}_expanded: {id, label, ...} on every record. */
export async function applyExpand(
  db: Database,
  records: DynamicRow[],
  expandPlan: ExpandTarget[],
): Promise<void> {
  if (expandPlan.length === 0 || records.length === 0) return;

  for (const exp of expandPlan) {
    const ids = [...new Set(records.map((r) => r[exp.field]).filter((v) => typeof v === 'string'))];
    if (ids.length === 0) continue;

    const rows = await sql<DynamicRow>`
      SELECT * FROM ${sql.id(exp.targetTable)}
      WHERE id = ANY(${ids})
    `.execute(db);

    const targetDef = (await DDLManager.getCollection(db, exp.targetCollection)) as CollectionDef;
    const byId = new Map<string, DynamicRow>();
    for (const r of rows.rows) {
      const serialized = await serializeRecord(r, targetDef);
      // Add a default `_label` (best-effort: name → title → email → id slice)
      const idVal = serialized.id;
      const label =
        serialized.name ??
        serialized.title ??
        serialized.label ??
        serialized.email ??
        serialized.full_name ??
        serialized.display_name ??
        (typeof idVal === 'string' ? idVal.slice(0, 8) : undefined) ??
        '—';
      byId.set(r.id as string, { ...serialized, _label: label });
    }
    for (const rec of records) {
      const id = rec[exp.field];
      if (typeof id === 'string' && byId.has(id)) {
        rec[`${exp.field}_expanded`] = byId.get(id) ?? null;
      }
    }
  }
}

/** Compute a strong ETag over a serialized payload (SHA-256, full hex). */
export async function computeEtag(data: DynamicRow[]): Promise<string> {
  const str = JSON.stringify(data);
  // SHA-256: stronger than SHA-1 and not truncated — avoids collision risk
  // (truncated SHA-1 to 64 bits had birthday-attack probability of ~2^-32).
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
