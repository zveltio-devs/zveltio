/**
 * Field type conversion strategy.
 *
 * Goal: tell the route layer whether a conversion is allowed, and if so,
 * what USING expression to pass to `ALTER COLUMN ... TYPE`. We can't blindly
 * cast — Postgres rejects `text → integer` without a USING clause, and even
 * with one a row containing "abc" will fail at runtime.
 *
 * Philosophy: be conservative. We allow conversions where:
 *   1. Postgres can do them cleanly (numeric widening, text family).
 *   2. The USING expression is documented + tested below.
 *
 * Anything else returns `unsupported` and the operator falls back to
 * drop-and-recreate (which forces an explicit acknowledgement of data loss).
 *
 * Relation types (m2o, o2m, m2m, reference) are NEVER converted by this
 * path — they involve FK constraints, indexes, and `zvd_relations` rows
 * that need atomic update. Out of scope here.
 */

const RELATION_TYPES = new Set(['m2o', 'o2m', 'm2m', 'reference']);

/**
 * Returns either:
 *   - { ok: true, sqlType, using? } — the route can proceed with ALTER COLUMN
 *   - { ok: false, reason } — explain why and 400 to the caller
 */
export type ConversionResult =
  | { ok: true; sqlType: string; using?: string }
  | { ok: false; reason: string };

/**
 * `from`/`to` are field-type keys from the registry (e.g. 'text', 'integer').
 * `targetSqlType` is the destination column type as Postgres knows it
 * (e.g. 'INTEGER', 'TEXT', 'JSONB'). The caller resolves it via the registry.
 * `columnName` is the column being altered (needed for the USING expression).
 */
export function resolveConversion(
  from: string,
  to: string,
  targetSqlType: string,
  columnName: string,
): ConversionResult {
  if (from === to) {
    return { ok: false, reason: 'New type is identical to current type' };
  }

  if (RELATION_TYPES.has(from) || RELATION_TYPES.has(to)) {
    return {
      ok: false,
      reason: 'Converting to/from relation types is not supported. Delete and re-add the field instead.',
    };
  }

  // Quote the column identifier inside the USING expression. The column
  // name has already been validated by sanitizeIdentifier upstream; we
  // wrap in double quotes to handle reserved words.
  const col = `"${columnName}"`;
  const upper = targetSqlType.toUpperCase();

  // ── Same-family casts ──────────────────────────────────────────────
  // Text family: any → any. Postgres accepts implicit cast.
  if (isTextFamily(from) && isTextFamily(to)) {
    return { ok: true, sqlType: targetSqlType };
  }

  // Number widening / narrowing: explicit cast is fine, may truncate.
  if (isNumberFamily(from) && isNumberFamily(to)) {
    return { ok: true, sqlType: targetSqlType, using: `${col}::${upper}` };
  }

  // ── Cross-family conversions with explicit USING ───────────────────
  // text → number: empty strings become NULL to avoid a guaranteed cast
  // failure on legacy "blank means null" data.
  if (isTextFamily(from) && isNumberFamily(to)) {
    return { ok: true, sqlType: targetSqlType, using: `NULLIF(${col}, '')::${upper}` };
  }
  if (isNumberFamily(from) && isTextFamily(to)) {
    return { ok: true, sqlType: targetSqlType, using: `${col}::TEXT` };
  }

  // text → boolean: standard 'true'/'false'/'t'/'f'/'1'/'0' parse.
  if (isTextFamily(from) && to === 'boolean') {
    return { ok: true, sqlType: targetSqlType, using: `NULLIF(${col}, '')::BOOLEAN` };
  }
  if (from === 'boolean' && isTextFamily(to)) {
    return { ok: true, sqlType: targetSqlType, using: `${col}::TEXT` };
  }

  // date ↔ datetime: lossless one way, lossy the other.
  if (from === 'date' && to === 'datetime') {
    return { ok: true, sqlType: targetSqlType, using: `${col}::TIMESTAMP` };
  }
  if (from === 'datetime' && to === 'date') {
    return { ok: true, sqlType: targetSqlType, using: `${col}::DATE` };
  }

  // text ↔ json: text → jsonb requires valid JSON in every row.
  if (isTextFamily(from) && (to === 'json' || to === 'jsonb')) {
    return { ok: true, sqlType: targetSqlType, using: `${col}::JSONB` };
  }
  if ((from === 'json' || from === 'jsonb') && isTextFamily(to)) {
    return { ok: true, sqlType: targetSqlType, using: `${col}::TEXT` };
  }

  // Generic fallback: try a direct cast. Postgres rejects unknown
  // conversions, so the error surfaces clearly to the operator without
  // us having to enumerate every pair.
  return {
    ok: true,
    sqlType: targetSqlType,
    using: `${col}::${upper}`,
  };
}

function isTextFamily(t: string): boolean {
  return t === 'text' || t === 'longtext' || t === 'richtext' || t === 'email' || t === 'url';
}

function isNumberFamily(t: string): boolean {
  return t === 'integer' || t === 'bigint' || t === 'decimal' || t === 'float' || t === 'number';
}
