#!/usr/bin/env bun
/**
 * Schema codegen.
 *
 * Walks every migration SQL file (engine + sibling zveltio-extensions)
 * and emits a single Kysely-compatible TypeScript module:
 *
 *   packages/engine/src/db/schema.generated.ts
 *
 * The generated module is the **authoritative** view of the database
 * schema. Hand-written `schema.ts` is kept for now as a re-export
 * shim so the rest of the codebase can switch over gradually.
 *
 * Mapping rules:
 *   PG type          → TS                          notes
 *   ─────────────────────────────────────────────────────────────────
 *   UUID, TEXT, VARCHAR(*) → string
 *   INT, INTEGER, SMALLINT, BIGINT, SERIAL → number   (BIGINT can
 *                                                       overflow JS
 *                                                       safe range —
 *                                                       documented in
 *                                                       comments only)
 *   NUMERIC(*), REAL, DOUBLE PRECISION → number
 *   BOOLEAN          → boolean
 *   TIMESTAMP(*), DATE, TIME → Date
 *   JSONB, JSON      → unknown                       (caller narrows)
 *   <name>[]         → T[]                           (array)
 *   vector(*)        → unknown                       (pgvector — no
 *                                                       canonical TS
 *                                                       shape, treated
 *                                                       as opaque)
 *   CHECK (col IN ('a','b','c')) → 'a' | 'b' | 'c'   union literal
 *
 *   NOT NULL DEFAULT … → Generated<T>      (caller may skip on INSERT)
 *   NOT NULL no def    → T                 (caller must provide)
 *   nullable           → T | null
 *   PRIMARY KEY (uuid) → Generated<string> when DEFAULT gen_random_uuid()
 *
 *   Quoted "camelCase"  → preserved case (Better-Auth tables).
 *   Unquoted            → lowercase (PG fold convention).
 *
 * Tables outside `zv_`, `zvd_`, or the Better-Auth set (user, session,
 * account, verification, twoFactor) are skipped.
 *
 * This reuses the parser logic from scripts/schema-drift-check.ts —
 * the two are designed to share a future common module. For now both
 * inline what they need; once codegen ships and the drift check
 * effectively reduces to "did codegen emit something different from
 * what's committed", the drift checker may be retired.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const EXT_ROOT = process.env.EXTENSIONS_ROOT ?? join(ROOT, '..', 'zveltio-extensions');
const OUT_PATH = join(ROOT, 'packages', 'engine', 'src', 'db', 'schema.generated.ts');

// Better-Auth tables that don't use a zv_/zvd_ prefix.
const BETTER_AUTH = new Set(['user', 'session', 'account', 'verification', 'twoFactor']);

type Column = {
  name: string; // case-preserved when quoted; lowercase otherwise
  pgType: string; // first token of the column spec, lowercased
  notNull: boolean;
  hasDefault: boolean;
  enumValues: string[] | null; // populated when a CHECK (col IN ('a','b',…)) is present
  isArray: boolean;
};

type Table = {
  name: string; // lowercased
  // Column declaration order: matters for the generated file output.
  columns: Column[];
  index: Map<string, number>; // column-name → position in `columns`
  source: string; // first migration file that mentioned it
};

const inv = new Map<string, Table>();

// ────────────────────────────────────────────────────────────────────
// File walking
// ────────────────────────────────────────────────────────────────────

function safeStat(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function walkSql(start: string): string[] {
  // Collect every *.sql file under `start`, then return them in a
  // deterministic alphabetical order by normalized path. Critical
  // because Linux readdir() vs Windows enumerate in different orders
  // — without sorting, an ALTER TABLE migration could be processed
  // BEFORE its CREATE TABLE, producing different column ordering on
  // the two platforms and a non-reproducible generated file.
  if (!safeStat(start)) return [];
  const out: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build')
        continue;
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(full);
      else if (s.isFile() && full.endsWith('.sql')) out.push(full);
    }
  }
  return out.sort((a, b) => a.replace(/\\/g, '/').localeCompare(b.replace(/\\/g, '/')));
}

// ────────────────────────────────────────────────────────────────────
// SQL → inventory parsing
// ────────────────────────────────────────────────────────────────────

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function getTable(name: string, source: string): Table {
  let t = inv.get(name);
  if (!t) {
    t = { name, columns: [], index: new Map(), source };
    inv.set(name, t);
  }
  return t;
}

function addColumn(t: Table, col: Column): void {
  if (t.index.has(col.name)) return; // first-declarer-wins (matches PG IF NOT EXISTS semantics)
  t.index.set(col.name, t.columns.length);
  t.columns.push(col);
}

function dropNotNull(t: Table, colName: string): void {
  const idx = t.index.get(colName);
  if (idx === undefined) return;
  t.columns[idx].notNull = false;
}

function isAllowedTable(name: string): boolean {
  return name.startsWith('zv_') || name.startsWith('zvd_') || BETTER_AUTH.has(name);
}

function parseSqlFile(filePath: string): void {
  const raw = readFileSync(filePath, 'utf8');
  const upSection = stripSqlComments(raw.split(/^--\s*DOWN\s*$/im)[0]);

  // CREATE TABLE
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s*\(([\s\S]*?)\)\s*;/gi;
  for (const m of upSection.matchAll(createRe)) {
    const rawName = m[1] ?? m[2];
    const tableName = m[1] ? rawName : rawName.toLowerCase();
    if (!isAllowedTable(tableName.toLowerCase())) continue;
    const t = getTable(tableName.toLowerCase(), filePath);
    for (const col of parseColumns(m[3])) addColumn(t, col);
  }

  // ALTER TABLE ... ADD COLUMN
  const alterRe = /ALTER\s+TABLE\s+(?:public\.)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+([\s\S]*?);/gi;
  for (const m of upSection.matchAll(alterRe)) {
    const rawName = m[1] ?? m[2];
    const tableName = m[1] ? rawName : rawName.toLowerCase();
    if (!isAllowedTable(tableName.toLowerCase())) continue;
    const body = m[3];

    if (/ADD\s+COLUMN/i.test(body)) {
      const t = getTable(tableName.toLowerCase(), filePath);
      const addRe =
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+([\s\S]+?)(?=,\s*ADD\b|,\s*DROP\b|,\s*ALTER\b|$)/gi;
      for (const a of body.matchAll(addRe)) {
        const colName = a[1] ?? a[2].toLowerCase();
        addColumn(t, parseColumnSpec(colName, a[3].trim()));
      }
    }
    if (/ALTER\s+COLUMN.*DROP\s+NOT\s+NULL/i.test(body)) {
      const t = getTable(tableName.toLowerCase(), filePath);
      const re = /ALTER\s+COLUMN\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+DROP\s+NOT\s+NULL/gi;
      for (const x of body.matchAll(re)) dropNotNull(t, x[1] ?? x[2].toLowerCase());
    }
  }
}

function parseColumns(body: string): Column[] {
  const cols: Column[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      const col = tryParseColumn(cur.trim());
      if (col) cols.push(col);
      cur = '';
    } else cur += c;
  }
  const last = tryParseColumn(cur.trim());
  if (last) cols.push(last);
  return cols;
}

function tryParseColumn(line: string): Column | null {
  const lower = line.toLowerCase();
  if (
    /^primary\s+key\b/.test(lower) ||
    /^unique\s*\(/.test(lower) ||
    /^foreign\s+key\b/.test(lower) ||
    /^check\s*\(/.test(lower) ||
    /^constraint\b/.test(lower) ||
    /^exclude\b/.test(lower)
  )
    return null;

  // Quoted: "name" type ...
  let m = line.match(/^"([^"]+)"\s+([\s\S]+)$/);
  if (m) return parseColumnSpec(m[1], m[2].trim());

  // Unquoted: name type ...
  m = line.match(/^([a-z_][a-z0-9_]*)\s+([\s\S]+)$/i);
  if (!m) return null;
  return parseColumnSpec(m[1].toLowerCase(), m[2].trim());
}

function parseColumnSpec(name: string, spec: string): Column {
  const upper = spec.toUpperCase();
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/.test(upper);
  // PRIMARY KEY implies NOT NULL in Postgres.
  const notNull = /\bNOT\s+NULL\b/.test(upper) || isPrimaryKey;
  const hasDefault = /\bDEFAULT\b/.test(upper) || isPrimaryKey;

  // Detect type (everything before the first NOT/NULL/DEFAULT/CHECK/REFERENCES/UNIQUE/PRIMARY/COLLATE/GENERATED).
  // Allow `<type>(args)` and `<type>[]`.
  const typeMatch = spec.match(
    /^([A-Za-z][A-Za-z _]*?(?:\s*\([^)]*\))?(?:\s*\[\])?)\s*(?:\b(?:NOT|NULL|DEFAULT|CHECK|REFERENCES|UNIQUE|PRIMARY|COLLATE|GENERATED|CONSTRAINT)\b|$)/i,
  );
  let pgType = (typeMatch?.[1] ?? '').trim().toLowerCase();
  const isArray = /\[\]$/.test(pgType);
  if (isArray) pgType = pgType.replace(/\s*\[\]$/, '');

  // CHECK (<col> IN ('a','b','c')) → enum members. Only when the
  // constrained column is the SAME column we're declaring (so we
  // don't propagate a table-level CHECK to the wrong field).
  let enumValues: string[] | null = null;
  const checkRe = new RegExp(
    `CHECK\\s*\\(\\s*"?${escapeReg(name)}"?\\s+IN\\s*\\(([^)]+)\\)\\s*\\)`,
    'i',
  );
  const checkMatch = spec.match(checkRe);
  if (checkMatch) {
    enumValues = [...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  return { name, pgType, notNull, hasDefault, enumValues, isArray };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────────────────────────────────────────────
// PG → TS mapping
// ────────────────────────────────────────────────────────────────────

function pgToTs(col: Column): string {
  const base = baseTypeOf(col);
  const arr = col.isArray ? `${base}[]` : base;
  if (!col.notNull) {
    return col.hasDefault ? `Generated<${arr} | null>` : `${arr} | null`;
  }
  return col.hasDefault ? `Generated<${arr}>` : arr;
}

function baseTypeOf(col: Column): string {
  if (col.enumValues && col.enumValues.length > 0) {
    return col.enumValues.map((v) => `'${v}'`).join(' | ');
  }
  const t = col.pgType;
  // Strip type modifiers
  const head = t.replace(/\s*\([^)]*\)/g, '').trim();
  switch (head) {
    case 'text':
    case 'varchar':
    case 'character varying':
    case 'character':
    case 'char':
    case 'uuid':
    case 'inet':
    case 'cidr':
    case 'macaddr':
      return 'string';
    case 'int':
    case 'integer':
    case 'int4':
    case 'smallint':
    case 'int2':
    case 'bigint':
    case 'int8':
    case 'serial':
    case 'bigserial':
    case 'smallserial':
    case 'numeric':
    case 'decimal':
    case 'real':
    case 'double precision':
    case 'float4':
    case 'float8':
      return 'number';
    case 'boolean':
    case 'bool':
      return 'boolean';
    case 'timestamp':
    case 'timestamptz':
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'date':
    case 'time':
    case 'timetz':
      return 'Date';
    case 'jsonb':
    case 'json':
      return 'unknown';
    case 'bytea':
      return 'Uint8Array';
    case 'vector':
      return 'unknown';
    default:
      return 'unknown';
  }
}

// ────────────────────────────────────────────────────────────────────
// Emit
// ────────────────────────────────────────────────────────────────────

function interfaceNameFor(tableName: string): string {
  if (BETTER_AUTH.has(tableName)) {
    // user → UserTable, twoFactor → TwoFactorTable
    return tableName.charAt(0).toUpperCase() + tableName.slice(1) + 'Table';
  }
  // zv_api_keys → ZvApiKeysTable; zvd_collections → ZvdCollectionsTable
  return (
    tableName
      .split('_')
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('') + 'Table'
  );
}

function emit(): string {
  const out: string[] = [];
  out.push('/**');
  out.push(' * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.');
  out.push(' *');
  out.push(' * Regenerate with `bun run scripts/schema-codegen.ts` from the repo root.');
  out.push(' * Sources: every *.sql file under');
  out.push(' *   - packages/engine/src/db/migrations/sql/');
  out.push(' *   - $EXTENSIONS_ROOT (default: ../zveltio-extensions) / <ext>/engine/migrations/');
  out.push(' *');
  out.push(' * Sister checker: `scripts/schema-drift-check.ts` diffs this output');
  out.push(' * against route/lib usage and flags mismatches.');
  out.push(' */');
  out.push('');
  out.push(
    '// biome-ignore-all lint/style/useNamingConvention: PG column names + Better-Auth use mixed conventions',
  );
  out.push('');
  out.push("import type { Generated } from 'kysely';");
  out.push('');

  const tableNames = [...inv.keys()].sort();
  // Better-Auth first
  const sorted = [
    ...tableNames.filter((n) => BETTER_AUTH.has(n)),
    ...tableNames.filter((n) => n.startsWith('zv_')),
    ...tableNames.filter((n) => n.startsWith('zvd_')),
  ];

  for (const t of sorted) {
    const table = inv.get(t)!;
    out.push(`export interface ${interfaceNameFor(t)} {`);
    for (const col of table.columns) {
      const ts = pgToTs(col);
      const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(col.name) ? col.name : `'${col.name}'`;
      out.push(`  ${safeName}: ${ts};`);
    }
    out.push('}');
    out.push('');
  }

  out.push('export interface DbSchema {');
  for (const t of sorted) {
    const tableKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(t) ? t : `'${t}'`;
    out.push(`  ${tableKey}: ${interfaceNameFor(t)};`);
  }
  out.push('}');
  out.push('');

  return out.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

function main() {
  for (const f of walkSql(join(ROOT, 'packages', 'engine', 'src', 'db', 'migrations', 'sql')))
    parseSqlFile(f);
  for (const f of walkSql(EXT_ROOT)) parseSqlFile(f);

  const output = emit();
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, output, 'utf8');
  console.log(`✅ Emitted ${inv.size} table interfaces to ${relPath(OUT_PATH)}`);
}

function relPath(p: string): string {
  return p.replace(ROOT + '/', '').replace(ROOT + '\\', '');
}

main();
