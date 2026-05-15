/**
 * SQL → TypeScript codegen for extension-owned tables (S4-01).
 *
 * The aim: extensions' `ctx.db` is currently typed `any`, so a column rename
 * is a silent runtime failure. This module parses an extension's migration
 * SQL files and emits a `.d.ts` describing every table the extension owns,
 * keyed for Kysely. Result: `ctx.db.selectFrom('zv_forms')` autocompletes
 * column names in editors and `tsc` catches typos.
 *
 * Scope intentionally narrow:
 *   - Handles `CREATE TABLE [IF NOT EXISTS]` and `ALTER TABLE … ADD COLUMN`.
 *   - Maps the common Postgres types we see in extension migrations to TS.
 *   - Ignores constraint-only ALTER TABLE statements (PRIMARY KEY, FK).
 *   - Ignores CREATE INDEX, CREATE TYPE, CREATE FUNCTION, etc.
 *
 * Anything more exotic falls back to `unknown` so downstream code still
 * compiles. The migration author is free to widen this module's regex when
 * a real case arises.
 */

export interface Column {
  name: string;
  /** TypeScript type (e.g. 'string', 'number | null', 'Record<string, unknown>'). */
  tsType: string;
  /** The raw Postgres type as parsed — useful for codegen comments. */
  pgType: string;
  nullable: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
}

export interface ParsedSchema {
  tables: Table[];
}

// ─── Postgres → TypeScript type map ────────────────────────────────────────

const NUMERIC_TYPES = new Set([
  'int', 'int2', 'int4', 'int8',
  'integer', 'bigint', 'smallint',
  'serial', 'bigserial', 'smallserial',
  'numeric', 'decimal', 'real', 'double precision', 'float', 'float4', 'float8',
]);

const STRING_TYPES = new Set([
  'text', 'varchar', 'char', 'character', 'character varying', 'name',
  'uuid', 'citext', 'inet', 'cidr', 'macaddr',
]);

const BOOLEAN_TYPES = new Set(['boolean', 'bool']);
const DATE_TYPES = new Set([
  'date', 'time', 'timetz',
  'timestamp', 'timestamptz',
  'timestamp without time zone', 'timestamp with time zone',
  'time without time zone', 'time with time zone',
]);
const JSON_TYPES = new Set(['json', 'jsonb']);
const BYTES_TYPES = new Set(['bytea']);

function mapPgTypeToTs(pgType: string): string {
  // Normalize: lower-case, strip array brackets (handled separately), trim modifiers
  const lower = pgType.toLowerCase().trim();
  const isArray = /\[\]\s*$/.test(lower);
  const base = lower.replace(/\[\]\s*$/, '').replace(/\(.*\)/, '').trim();

  let tsBase: string;
  if (NUMERIC_TYPES.has(base)) tsBase = 'number';
  else if (BOOLEAN_TYPES.has(base)) tsBase = 'boolean';
  else if (DATE_TYPES.has(base)) tsBase = 'Date';
  else if (JSON_TYPES.has(base)) tsBase = 'Record<string, unknown>';
  else if (BYTES_TYPES.has(base)) tsBase = 'Uint8Array';
  else if (STRING_TYPES.has(base)) tsBase = 'string';
  else tsBase = 'unknown';

  return isArray ? `${tsBase}[]` : tsBase;
}

// ─── SQL parsing ───────────────────────────────────────────────────────────

/**
 * Strip line comments (`-- …`) and block comments (`/* … * /`) so they don't
 * confuse the table/column regexes. Dollar-quoted blocks are preserved
 * verbatim (function bodies).
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  let inSingle = false;
  let dollarTag: string | null = null;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (dollarTag !== null) {
      out += ch;
      if (sql.startsWith(dollarTag, i)) {
        out += sql.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length;
        dollarTag = null;
      } else {
        i++;
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") { out += next; i += 2; }
      else if (ch === "'") { inSingle = false; i++; }
      else i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      // line comment until \n
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '$') {
      // detect dollar tag like $$ or $body$
      const m = sql.substring(i).match(/^\$[a-zA-Z_]*\$/);
      if (m) {
        dollarTag = m[0];
        out += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Find the matching closing `)` for the `(` at `openIdx`. Returns the index
 * of the closing paren, or -1 if unbalanced. Skips parens inside string
 * literals and dollar-quoted blocks.
 */
function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  const n = sql.length;
  let inSingle = false;
  let dollarTag: string | null = null;
  while (i < n) {
    const ch = sql[i];
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) { dollarTag = null; i += sql.substring(i).match(/^\$[a-zA-Z_]*\$/)![0].length; continue; }
      i++; continue;
    }
    if (inSingle) {
      if (ch === "'" && sql[i + 1] === "'") i += 2;
      else if (ch === "'") { inSingle = false; i++; }
      else i++;
      continue;
    }
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '$') {
      const m = sql.substring(i).match(/^\$[a-zA-Z_]*\$/);
      if (m) { dollarTag = m[0]; i += dollarTag.length; continue; }
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Parse a single CREATE TABLE body — the text between the outer parens —
 * into a list of columns. Constraint-only clauses (PRIMARY KEY (…), FOREIGN
 * KEY (…), CHECK (…), UNIQUE (…), CONSTRAINT …) are skipped.
 */
export function parseColumnList(body: string): Column[] {
  const columns: Column[] = [];
  // Split on top-level commas; tracking paren depth so types like `numeric(10,2)`
  // don't confuse us.
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    // Skip table-level constraints
    if (/^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like)\b/i.test(part)) continue;

    const col = parseColumnDef(part);
    if (col) columns.push(col);
  }
  return columns;
}

function parseColumnDef(line: string): Column | null {
  // Match: <identifier> <type>(...)? <rest>
  // Identifier can be quoted ("col name") or unquoted (col_name).
  const m = line.match(/^\s*(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s+(.+)$/);
  if (!m) return null;
  const name = m[1] ?? m[2];
  if (!name || name === '') return null;

  // The type can have a length modifier in parens, possibly followed by [] for arrays.
  // Examples: TEXT, VARCHAR(255), NUMERIC(10,2), TIMESTAMPTZ, INT[], GEOGRAPHY(POINT, 4326)
  const rest = m[3];
  const typeMatch = rest.match(
    /^((?:character\s+varying|character|double\s+precision|timestamp\s+(?:without|with)\s+time\s+zone|time\s+(?:without|with)\s+time\s+zone|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\([^)]*\))?(?:\s*\[\s*\])?)\s*(.*)$/i,
  );
  if (!typeMatch) return null;
  const pgType = typeMatch[1].trim();
  const tail = typeMatch[2] ?? '';

  const upperTail = ' ' + tail.toUpperCase() + ' ';
  // NOT NULL ⇒ non-nullable. PRIMARY KEY also implies NOT NULL.
  const notNull = / NOT NULL /.test(upperTail) || / PRIMARY KEY /.test(upperTail);
  const tsBase = mapPgTypeToTs(pgType);
  const tsType = notNull ? tsBase : `${tsBase} | null`;

  return { name, pgType, tsType, nullable: !notNull };
}

/**
 * Parse one or more migration SQL strings into a normalized schema. Tables
 * are merged across files: `CREATE TABLE foo (...)` followed by
 * `ALTER TABLE foo ADD COLUMN bar text` produces a single `foo` table with
 * `bar` appended. Last write wins for column re-declarations.
 */
export function parseSchema(sqlChunks: string[]): ParsedSchema {
  const tables = new Map<string, Map<string, Column>>();
  const order: string[] = [];

  const ensureTable = (name: string) => {
    if (!tables.has(name)) {
      tables.set(name, new Map());
      order.push(name);
    }
    return tables.get(name)!;
  };

  const allSql = sqlChunks.map(stripComments).join('\n');

  // CREATE TABLE [IF NOT EXISTS] <name> ( <body> )
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(allSql)) !== null) {
    const tableName = m[1] ?? m[2];
    const openIdx = createRe.lastIndex - 1; // position of '('
    const closeIdx = findMatchingParen(allSql, openIdx);
    if (closeIdx < 0) continue; // unbalanced — skip
    const body = allSql.substring(openIdx + 1, closeIdx);
    const columns = parseColumnList(body);
    const tableCols = ensureTable(tableName);
    for (const c of columns) tableCols.set(c.name, c);
    createRe.lastIndex = closeIdx + 1;
  }

  // ALTER TABLE <name> ADD COLUMN [IF NOT EXISTS] <col> <type> <rest>
  const alterRe = /ALTER\s+TABLE\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s+([^;]+?)(?=;|$)/gi;
  while ((m = alterRe.exec(allSql)) !== null) {
    const tableName = m[1] ?? m[2];
    const colName = m[3] ?? m[4];
    const tail = m[5];
    const col = parseColumnDef(`${colName} ${tail}`);
    if (col) {
      const tableCols = ensureTable(tableName);
      tableCols.set(col.name, col);
    }
  }

  return {
    tables: order.map((name) => ({ name, columns: [...tables.get(name)!.values()] })),
  };
}

// ─── Codegen ───────────────────────────────────────────────────────────────

export interface CodegenOptions {
  /** Top-level interface name (default: `ExtensionSchema`). */
  interfaceName?: string;
  /** Optional banner line above the file body (e.g. provenance comment). */
  banner?: string;
}

/**
 * Emit a Kysely-friendly `.d.ts`-style module body for a parsed schema.
 * The result is plain TypeScript; callers write it wherever (typically
 * `<extension>/.zveltio/db.d.ts`).
 */
export function emitTypeScript(schema: ParsedSchema, opts: CodegenOptions = {}): string {
  const interfaceName = opts.interfaceName ?? 'ExtensionSchema';
  const lines: string[] = [];
  lines.push('// AUTO-GENERATED by zveltio CLI — do NOT edit by hand.');
  lines.push('// Regenerate with: zveltio extension types');
  if (opts.banner) lines.push(`// ${opts.banner}`);
  lines.push('');
  lines.push('/* eslint-disable */');
  lines.push('');
  lines.push(`export interface ${interfaceName} {`);

  if (schema.tables.length === 0) {
    lines.push('  // No tables parsed from migrations.');
  }

  for (const t of schema.tables) {
    lines.push(`  ${quoteIdentifierIfNeeded(t.name)}: {`);
    for (const c of t.columns) {
      lines.push(`    ${quoteIdentifierIfNeeded(c.name)}: ${c.tsType}; // ${c.pgType}`);
    }
    lines.push('  };');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function quoteIdentifierIfNeeded(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "\\'")}'`;
}
