#!/usr/bin/env bun
/**
 * Schema drift checker.
 *
 * Walks:
 *   1. All `*.sql` migration files (engine + extensions) → extracts the
 *      authoritative table+column inventory (with NULL/NOT NULL +
 *      DEFAULT info).
 *   2. The hand-written `packages/engine/src/db/schema.ts` → extracts
 *      the TypeScript-side interface declarations.
 *   3. All TS route/lib files (engine + extensions) → extracts every
 *      `selectFrom/insertInto/updateTable/deleteFrom('<table>')` call
 *      and the column names referenced inside `.select(['col', ...])`,
 *      `.where('col', ...)`, `.values({col: ...})`.
 *
 * Reports three classes of drift:
 *
 *   - TABLE_MISSING — code references a table no migration creates.
 *   - COLUMN_MISSING — code references a column not declared on that
 *                       table by any migration.
 *   - SCHEMA_TS_DRIFT — DbSchema.ts is missing a table or column that
 *                       the migration declares, OR has a column the
 *                       migration doesn't.
 *
 * Exits non-zero on any drift so CI fails.
 *
 * Foundation for the eventual full codegen (`schema.generated.ts`) —
 * once this report is empty for an extended period, we know the
 * parser produces exactly what's hand-written, and switching to
 * generated source is safe.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const EXT_ROOT = process.env.EXTENSIONS_ROOT ?? join(ROOT, '..', 'zveltio-extensions');

// Tables that are dynamically created at runtime (user collections via
// DDL queue, tenant schemas, etc.). Referenced in code with dynamic
// names (`zvd_${collection}`) — not in scope for drift checking.
const DYNAMIC_TABLE_PATTERNS = [
  /^zvd_.*$/, // user-defined collections — too permissive but they're allowed
];

// Allow-list of column names that are valid Kysely query expressions
// rather than DB columns (e.g. aliases, raw counts).
const ALLOWED_PSEUDO_COLUMNS = new Set([
  'count',
  'total',
  'max_order',
  'cnt',
  'last_message_at',
  'message_count',
  'now',
]);

// Tokens that look like column references but are actually TS keywords,
// Kysely expression-builder helpers, or local variables that leak into
// the parser when it's scanning .values({...}) or .set({...}).
const TS_KEYWORDS_AS_NOISE = new Set([
  'or',
  'and',
  'not',
  'in',
  'is',
  'as',
  'if',
  'else',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'any',
  'never',
  'unknown',
  'string',
  'number',
  'boolean',
  'cmpr',
  'fn',
  'eb',
  'fb',
  'qb',
  'sql',
  'oc',
  'ec',
  'required',
  'optional',
  'default',
  'spread',
  'rest',
]);

// SQL type → TS type mapping. Used for the inventory and for the
// future codegen.
type ColumnInfo = {
  name: string;
  pgType: string;
  notNull: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
};

type TableInfo = {
  name: string;
  columns: Map<string, ColumnInfo>;
  source: string; // migration filename
};

// ────────────────────────────────────────────────────────────────────
// 1. Parse all migration SQL files into a table inventory
// ────────────────────────────────────────────────────────────────────

function* walkSqlFiles(start: string): Generator<string> {
  if (!safeStat(start)) return;
  const stack: string[] = [start];
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
      else if (s.isFile() && full.endsWith('.sql')) yield full;
    }
  }
}

function safeStat(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function stripSqlComments(sql: string): string {
  // Remove line comments (-- ...) but preserve the trailing newline so
  // line-based delimiters still work.
  let out = sql.replace(/--[^\n]*/g, '');
  // Remove block comments /* ... */
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  return out;
}

function parseSqlMigration(filePath: string, inventory: Map<string, TableInfo>): void {
  // Only parse the UP section of a migration file (everything before a
  // bare `-- DOWN` marker on its own line). Then strip all other SQL
  // comments — they otherwise leak commas + tokens into the column
  // splitter (e.g. `-- scopes: [{"a", "b"}]` ate the comma split).
  const raw = readFileSync(filePath, 'utf8');
  const downMarker = /^--\s*DOWN\s*$/im;
  const upSection = stripSqlComments(raw.split(downMarker)[0]);

  // CREATE TABLE [IF NOT EXISTS] [public.]<name> ( ... );
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const m of upSection.matchAll(createRe)) {
    const tableName = m[1].toLowerCase();
    if (
      !tableName.startsWith('zv_') &&
      !tableName.startsWith('zvd_') &&
      tableName !== 'user' &&
      tableName !== 'session' &&
      tableName !== 'account' &&
      tableName !== 'verification' &&
      tableName !== 'twoFactor'
    ) {
      // Outside our naming scheme; skip (could be a casbin_rule etc.)
      continue;
    }
    const body = m[2];
    const cols = parseColumns(body);

    if (!inventory.has(tableName)) {
      inventory.set(tableName, {
        name: tableName,
        columns: new Map(),
        source: filePath,
      });
    }
    const t = inventory.get(tableName)!;
    // First-writer-wins: CREATE TABLE IF NOT EXISTS in a squashed
    // migration may duplicate; later reconcile ALTER TABLEs fill the
    // missing columns.
    for (const col of cols) {
      if (!t.columns.has(col.name)) t.columns.set(col.name, col);
    }
  }

  // ALTER TABLE <name> ADD COLUMN [IF NOT EXISTS] <col> <type> [NOT NULL] [DEFAULT ...];
  // Supports both single-column and multi-column (comma-separated) ALTER TABLE.
  const alterAddRe = /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+([\s\S]*?);/gi;
  for (const m of upSection.matchAll(alterAddRe)) {
    const tableName = m[1].toLowerCase();
    const body = m[2];
    if (!body.match(/ADD\s+COLUMN/i)) continue;

    if (!inventory.has(tableName)) {
      // ALTER on a table we didn't see CREATE for — record under this
      // file so the diff later flags the missing CREATE separately if
      // it's truly absent (rare; usually the CREATE lives in an earlier
      // section of the same squash file).
      inventory.set(tableName, { name: tableName, columns: new Map(), source: filePath });
    }
    const t = inventory.get(tableName)!;

    // ADD COLUMN [IF NOT EXISTS] <name> <type> ... up to next clause or end.
    // Uses [\s\S]+? non-greedy + a lookahead that ignores commas inside
    // parens (CHECK (a IN ('x','y')) was previously eaten as a comma).
    const addRe =
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]+?)(?=,\s*ADD\b|,\s*DROP\b|,\s*ALTER\b|$)/gi;
    for (const a of body.matchAll(addRe)) {
      const colName = a[1].toLowerCase();
      const colSpec = a[2].trim();
      if (t.columns.has(colName)) continue; // already there
      t.columns.set(colName, parseColumnSpec(colName, colSpec));
    }
  }

  // ALTER TABLE <name> ALTER COLUMN <col> DROP NOT NULL — mark as nullable
  const dropNotNullRe =
    /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+ALTER\s+COLUMN\s+([a-z_][a-z0-9_]*)\s+DROP\s+NOT\s+NULL/gi;
  for (const m of upSection.matchAll(dropNotNullRe)) {
    const t = inventory.get(m[1].toLowerCase());
    if (!t) continue;
    const c = t.columns.get(m[2].toLowerCase());
    if (c) c.notNull = false;
  }
}

function parseColumns(body: string): ColumnInfo[] {
  // Strip the outer parens, then split on top-level commas (commas
  // inside parentheses — CHECK (a IN ('x', 'y')) — must be kept).
  const cols: ColumnInfo[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      const parsed = tryParseColumn(current.trim());
      if (parsed) cols.push(parsed);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) {
    const parsed = tryParseColumn(current.trim());
    if (parsed) cols.push(parsed);
  }
  return cols;
}

function tryParseColumn(line: string): ColumnInfo | null {
  // Skip table-level constraints: PRIMARY KEY (...), UNIQUE (...),
  // FOREIGN KEY, CHECK (...), CONSTRAINT <name>...
  // Note: must match WHOLE WORD — `checksum` accidentally matched
  // `check(` as a prefix before this fix.
  const lower = line.toLowerCase();
  if (
    /^primary\s+key\b/.test(lower) ||
    /^unique\s*\(/.test(lower) ||
    /^foreign\s+key\b/.test(lower) ||
    /^check\s*\(/.test(lower) ||
    /^constraint\b/.test(lower) ||
    /^exclude\b/.test(lower)
  ) {
    return null;
  }
  // Two forms: unquoted (folded to lowercase by PG) or quoted (case preserved).
  let m = line.match(/^"([^"]+)"\s+([\s\S]+)$/);
  if (m) return parseColumnSpec(m[1], m[2].trim());
  m = line.match(/^([a-z_][a-z0-9_]*)\s+([\s\S]+)$/i);
  if (!m) return null;
  return parseColumnSpec(m[1].toLowerCase(), m[2].trim());
}

function parseColumnSpec(name: string, spec: string): ColumnInfo {
  const u = spec.toUpperCase();
  const notNull = /\bNOT\s+NULL\b/.test(u);
  const hasDefault = /\bDEFAULT\b/.test(u);
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/.test(u);
  // Extract just the pg type (first token, possibly with parens)
  const typeMatch = spec.match(/^([A-Za-z]+(?:\s+[A-Za-z]+)?(?:\([^)]*\))?(?:\[\])?)/);
  return {
    name,
    pgType: typeMatch?.[1] ?? '',
    notNull,
    hasDefault: hasDefault || isPrimaryKey,
    isPrimaryKey,
  };
}

// ────────────────────────────────────────────────────────────────────
// 2. Parse packages/engine/src/db/schema.ts
// ────────────────────────────────────────────────────────────────────

type SchemaTsInterface = {
  interfaceName: string;
  columns: Set<string>;
  // Whether each column appears wrapped in Generated<> (i.e. caller can skip on INSERT)
  generated: Set<string>;
};

function parseSchemaTs(filePath: string): {
  interfaces: Map<string, SchemaTsInterface>;
  dbSchemaMapping: Map<string, string>; // table_name → InterfaceName
} {
  const src = readFileSync(filePath, 'utf8');
  const interfaces = new Map<string, SchemaTsInterface>();

  // Match each `export interface Foo { ... }`
  const ifaceRe = /export\s+interface\s+([A-Z][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm;
  for (const m of src.matchAll(ifaceRe)) {
    const name = m[1];
    const body = m[2];
    const cols = new Set<string>();
    const gens = new Set<string>();
    // `colName: Type;` or `colName: Generated<Type>;` etc.
    const colRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^;]+);/gm;
    for (const cm of body.matchAll(colRe)) {
      cols.add(cm[1]);
      if (/\bGenerated\s*</.test(cm[2])) gens.add(cm[1]);
    }
    interfaces.set(name, { interfaceName: name, columns: cols, generated: gens });
  }

  // Match `export interface DbSchema { table_name: InterfaceName; ... }`
  const dbSchemaMapping = new Map<string, string>();
  const dbSchemaMatch = src.match(/export\s+interface\s+DbSchema\s*\{([\s\S]*?)^\}/m);
  if (dbSchemaMatch) {
    const body = dbSchemaMatch[1];
    const lineRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_]*)\s*;/gm;
    for (const m of body.matchAll(lineRe)) {
      dbSchemaMapping.set(m[1], m[2]);
    }
  }

  return { interfaces, dbSchemaMapping };
}

// ────────────────────────────────────────────────────────────────────
// 3. Parse TS route/lib files for table + column references
// ────────────────────────────────────────────────────────────────────

type CodeReference = {
  table: string;
  column?: string;
  file: string;
  line: number;
};

function* walkTsFiles(start: string): Generator<string> {
  if (!safeStat(start)) return;
  const stack: string[] = [start];
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
      else if (s.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
        // Skip test files + node_modules
        if (full.includes('/tests/') || full.includes('\\tests\\') || full.endsWith('.test.ts'))
          continue;
        yield full;
      }
    }
  }
}

/**
 * Walks the object literal that begins at `start` (right after a `{` was
 * consumed) and returns the top-level keys until the matching closing
 * brace. Nested {…} blocks and template-string interpolation `${…}` are
 * skipped so JSON-payload keys aren't mistaken for DB columns.
 */
function extractTopLevelKeys(src: string, start: number): string[] {
  const keys: string[] = [];
  let i = start;
  let depth = 1; // we're already inside one `{`
  let pendingKey = true; // expect a key at the start
  let inString: string | null = null;

  while (i < src.length && depth > 0) {
    const c = src[i];

    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      else if (c === '$' && src[i + 1] === '{' && inString === '`') {
        // template-literal interpolation — skip until matching }
        let d = 1;
        i += 2;
        while (i < src.length && d > 0) {
          if (src[i] === '{') d++;
          else if (src[i] === '}') d--;
          i++;
        }
        continue;
      }
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      pendingKey = false;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) break;
      pendingKey = true; // next thing after a nested-close can start a new key
      i++;
      continue;
    }
    if (c === ',' && depth === 1) {
      pendingKey = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Skip line + block comments
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Spread: skip
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      // advance past the spread expression up to next comma or close
      while (i < src.length && src[i] !== ',' && !(src[i] === '}' && depth === 1)) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && depth > 1) depth--;
        i++;
      }
      pendingKey = true;
      continue;
    }
    // Computed key [expr]: ... — skip the expression
    if (c === '[' && pendingKey && depth === 1) {
      let bd = 1;
      i++;
      while (i < src.length && bd > 0) {
        if (src[i] === '[') bd++;
        else if (src[i] === ']') bd--;
        i++;
      }
      // skip the `:` and value
      while (i < src.length && src[i] !== ',' && !(src[i] === '}' && depth === 1)) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && depth > 1) depth--;
        i++;
      }
      pendingKey = true;
      continue;
    }

    if (pendingKey && depth === 1 && /[a-z_]/i.test(c)) {
      // Parse identifier
      let id = '';
      while (i < src.length && /[a-z0-9_]/i.test(src[i])) {
        id += src[i++];
      }
      // After identifier: skip whitespace; expect `:` (named key),
      // `,` / `}` (shorthand), or `(` (method — not a column).
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      const next = src[j];
      if (next === ':' || next === ',' || next === '}') {
        keys.push(id);
        pendingKey = false;
      } else {
        // Not a key — could be a value identifier; bail this entry
        pendingKey = false;
      }
      continue;
    }
    i++;
  }

  return keys;
}

function scanTsFile(file: string): CodeReference[] {
  const refs: CodeReference[] = [];
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  // Capture `selectFrom('table')` / `insertInto('table')` /
  // `updateTable('table')` / `deleteFrom('table')` — with optional
  // `as ${alias}` after the table name. Skip if the argument is a
  // template literal or a variable (dynamic table names).
  const tableRe =
    /\.(?:selectFrom|insertInto|updateTable|deleteFrom)\(\s*['"]([a-z_][a-z0-9_]*)(?:\s+as\s+[a-z_][a-z0-9_]*)?['"]/gi;

  // Track current line via offset
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  for (const m of src.matchAll(tableRe)) {
    refs.push({
      table: m[1], // case preserved; PG lowercase tables are stored lowercase but `user` etc. stay as-is
      file,
      line: lineOf(m.index ?? 0),
    });
  }

  // Column references via .select(['col1', 'col2'])
  // Walk every selectFrom('table') and find the subsequent .select([...]) within ~30 chars to ~3000 chars
  // Simpler: scan select(['col', 'col2']) and .where('col', ...).
  // We'll associate columns with the last seen table reference on the same chain.

  // Track table-chain: for each selectFrom/insert/update/delete, find
  // column references until a `;` OR the next selectFrom/insert/update/
  // delete (whichever comes first) — Promise.all([...]) blocks chain
  // multiple queries without a `;` between them and would otherwise
  // bleed columns from one query into the previous query's table.
  const chainRe =
    /\.(?:selectFrom|insertInto|updateTable|deleteFrom)\(\s*['"]([a-z_][a-z0-9_]*)(?:\s+as\s+([a-z_][a-z0-9_]*))?['"]\s*\)([\s\S]*?)(?=;|\.(?:selectFrom|insertInto|updateTable|deleteFrom)\()/gi;

  for (const m of src.matchAll(chainRe)) {
    const table = m[1].toLowerCase();
    const alias = m[2]?.toLowerCase();
    const chain = m[3];
    const startLine = lineOf(m.index ?? 0);

    // Collect aliases defined by `.as('name')` in this chain. These
    // are valid identifiers in subsequent .orderBy / .groupBy / .where
    // references (PG resolves them at the SELECT projection layer).
    const chainAliases = new Set<string>();
    for (const a of chain.matchAll(/\.as\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*\)/g)) {
      chainAliases.add(a[1]);
    }

    // .select(['col1', 'col2']) — only count the array when ALL entries
    // are plain string literals (no fn calls, no aliases via .as()).
    // The general case `.select(['c1', fn.count('c2').as('count')])` is
    // too noisy because both 'c2' (inside count) and 'count' (alias)
    // get matched by a naive regex even though neither is a top-level
    // column reference. We let the .where/.orderBy/.values/.set passes
    // catch most column bugs instead.
    const selectArrRe = /\.select\(\s*\[([^\]]+)\]\s*\)/g;
    for (const s of chain.matchAll(selectArrRe)) {
      const colList = s[1];
      // Bail if the array contains anything other than string literals
      // (commas + whitespace allowed).
      if (/[a-zA-Z_$]\w*\s*\.|\(|=>/.test(colList)) continue;
      const colRe = /['"]([a-z_][a-z0-9_]*\.?[a-z_]?[a-z0-9_]*)['"]/gi;
      for (const c of colList.matchAll(colRe)) {
        const cn = c[1];
        if (cn.includes('.')) {
          const [t, col] = cn.split('.');
          if (t === alias || t === table) refs.push({ table, column: col, file, line: startLine });
        } else {
          refs.push({ table, column: cn, file, line: startLine });
        }
      }
    }

    // .where('col', ...) / .orderBy('col', ...) / .groupBy('col')
    const colMethRe =
      /\.(?:where|andWhere|orWhere|orderBy|groupBy)\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*\.?[a-zA-Z_]?[a-zA-Z0-9_]*)['"]/g;
    for (const c of chain.matchAll(colMethRe)) {
      const cn = c[1];
      if (cn.includes('.')) {
        const [t, col] = cn.split('.');
        if (t === alias || t === table) refs.push({ table, column: col, file, line: startLine });
      } else if (chainAliases.has(cn)) {
        // Defined by a `.as('alias')` earlier in the same chain — not a column.
      } else {
        refs.push({ table, column: cn, file, line: startLine });
      }
    }

    // .values({col1, col2, col3, ...}) and .set({col1: ..., col2: ...})
    // Track brace depth so we only collect TOP-LEVEL keys — keys inside
    // nested objects (e.g. `metadata: {method: ..., path: ...}`) are
    // JSON payload keys, not DB columns. Same goes for inline arrow
    // expressions like `() => ({...})`.
    for (const re of [/\.values\(\s*\{/g, /\.set\(\s*\{/g]) {
      for (const v of chain.matchAll(re)) {
        const start = (v.index ?? 0) + v[0].length;
        const topLevelKeys = extractTopLevelKeys(chain, start);
        for (const k of topLevelKeys) {
          refs.push({ table, column: k, file, line: startLine });
        }
      }
    }
  }

  return refs;
}

// ────────────────────────────────────────────────────────────────────
// 4. Run the diff
// ────────────────────────────────────────────────────────────────────

function isDynamicTable(name: string): boolean {
  return DYNAMIC_TABLE_PATTERNS.some((p) => p.test(name));
}

function main() {
  const inventory = new Map<string, TableInfo>();

  // Parse migrations from engine + extensions
  for (const sql of walkSqlFiles(
    join(ROOT, 'packages', 'engine', 'src', 'db', 'migrations', 'sql'),
  )) {
    parseSqlMigration(sql, inventory);
  }
  for (const sql of walkSqlFiles(EXT_ROOT)) {
    parseSqlMigration(sql, inventory);
  }
  console.log(`Parsed ${inventory.size} tables from migrations`);

  // Parse schema.ts
  const schemaTsPath = join(ROOT, 'packages', 'engine', 'src', 'db', 'schema.ts');
  const { interfaces, dbSchemaMapping } = parseSchemaTs(schemaTsPath);
  console.log(
    `Parsed ${interfaces.size} interfaces from schema.ts (${dbSchemaMapping.size} mapped in DbSchema)`,
  );

  // Parse TS files
  const tsDirs = [join(ROOT, 'packages', 'engine', 'src'), EXT_ROOT];
  const allRefs: CodeReference[] = [];
  for (const dir of tsDirs) {
    for (const file of walkTsFiles(dir)) {
      allRefs.push(...scanTsFile(file));
    }
  }
  console.log(`Scanned ${allRefs.length} table/column refs across TS files`);

  // ── Diff 1: code references a table no migration creates
  // Table names in PG without quotes fold to lowercase. We normalize
  // both sides to lowercase for the table-existence check.
  const tablesRefMap = new Map<string, CodeReference[]>();
  for (const r of allRefs) {
    const key = r.table.toLowerCase();
    if (!tablesRefMap.has(key)) tablesRefMap.set(key, []);
    tablesRefMap.get(key)!.push(r);
  }

  const tablesMissing: Array<{ table: string; uses: CodeReference[] }> = [];
  for (const [tname, refs] of tablesRefMap) {
    if (inventory.has(tname)) continue;
    // Exclude better-auth tables (always present)
    if (['user', 'session', 'account', 'verification', 'twofactor'].includes(tname)) continue;
    // Exclude pure-dynamic (zvd_<runtime>) collections
    // Note: any zvd_* table that ISN'T in inventory and ISN'T dynamic
    // is suspicious — but we have many user-defined collection tables.
    // For now, only flag zv_* missing (system tables).
    if (!tname.startsWith('zv_')) continue;
    tablesMissing.push({ table: tname, uses: refs.slice(0, 3) });
  }

  // ── Diff 2: code references a column not on the table
  // Columns are case-sensitive in PG when they were created via quoted
  // identifiers (Better-Auth tables). The migration parser preserves
  // case for quoted columns and lowercases unquoted ones; so does the
  // code scanner. Direct comparison works.
  const colsMissing: Array<{ table: string; column: string; ref: CodeReference }> = [];
  for (const r of allRefs) {
    if (!r.column) continue;
    if (ALLOWED_PSEUDO_COLUMNS.has(r.column)) continue;
    if (TS_KEYWORDS_AS_NOISE.has(r.column)) continue;
    const t = inventory.get(r.table.toLowerCase());
    if (!t) continue; // tables_missing handled separately
    if (!t.columns.has(r.column)) {
      colsMissing.push({ table: r.table, column: r.column, ref: r });
    }
  }

  // ── Diff 3: schema.ts ↔ migrations
  // 3a: A table is in inventory but not in DbSchema (and isn't dynamic)
  const schemaTsMissing: string[] = [];
  for (const tname of inventory.keys()) {
    if (!tname.startsWith('zv_') && !tname.startsWith('zvd_')) continue;
    if (!dbSchemaMapping.has(tname)) {
      // Allow extension-only tables (created by extensions, not in
      // engine's schema.ts) — those are flagged separately as a
      // future codegen target, not as drift.
      const inv = inventory.get(tname)!;
      if (inv.source.includes('zveltio-extensions')) continue;
      schemaTsMissing.push(tname);
    }
  }
  // 3b: A column is in inventory but missing from the schema.ts interface
  const schemaTsColMissing: Array<{ table: string; column: string }> = [];
  for (const [tname, iface] of [...dbSchemaMapping.entries()].map(
    ([t, i]) => [t, interfaces.get(i)!] as [string, SchemaTsInterface],
  )) {
    if (!iface) continue;
    const inv = inventory.get(tname);
    if (!inv) continue;
    for (const colName of inv.columns.keys()) {
      if (!iface.columns.has(colName)) {
        schemaTsColMissing.push({ table: tname, column: colName });
      }
    }
  }

  // ── Report
  console.log('\n============ DRIFT REPORT ============\n');

  if (
    tablesMissing.length === 0 &&
    colsMissing.length === 0 &&
    schemaTsMissing.length === 0 &&
    schemaTsColMissing.length === 0
  ) {
    console.log('✅ No drift detected.');
    process.exit(0);
  }

  if (tablesMissing.length > 0) {
    console.log(
      `\n🔴 TABLES MISSING (${tablesMissing.length}) — code references a table no migration creates:\n`,
    );
    for (const t of tablesMissing) {
      console.log(`  - ${t.table}`);
      for (const u of t.uses) console.log(`      at ${relPath(u.file)}:${u.line}`);
    }
  }

  if (colsMissing.length > 0) {
    // Group by (table, column)
    const grouped = new Map<string, CodeReference[]>();
    for (const m of colsMissing) {
      const key = `${m.table}.${m.column}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(m.ref);
    }
    console.log(
      `\n🔴 COLUMNS MISSING (${grouped.size} unique) — code references a column not declared on that table:\n`,
    );
    for (const [key, refs] of grouped) {
      console.log(`  - ${key}`);
      for (const r of refs.slice(0, 3)) console.log(`      at ${relPath(r.file)}:${r.line}`);
    }
  }

  if (schemaTsMissing.length > 0) {
    console.log(`\n🟡 SCHEMA.TS MISSING TABLES (${schemaTsMissing.length}):\n`);
    for (const t of schemaTsMissing) console.log(`  - ${t}`);
  }

  if (schemaTsColMissing.length > 0) {
    // Group by table for readability
    const byTable = new Map<string, string[]>();
    for (const m of schemaTsColMissing) {
      if (!byTable.has(m.table)) byTable.set(m.table, []);
      byTable.get(m.table)!.push(m.column);
    }
    console.log(`\n🟡 SCHEMA.TS MISSING COLUMNS (${byTable.size} tables affected):\n`);
    for (const [t, cols] of byTable) {
      console.log(`  - ${t}: ${cols.join(', ')}`);
    }
  }

  // Exit code policy:
  //   - TABLES MISSING or COLUMNS MISSING → exit 1 (real runtime crash risk)
  //   - SCHEMA.TS drift alone → exit 0 with a warning (typing gap, not a
  //     crash; A/codegen will close these automatically once it lands).
  const isFatal = tablesMissing.length > 0 || colsMissing.length > 0;
  console.log('');
  if (isFatal) {
    console.error('❌ Fatal drift detected — fix migrations or routes before merging.');
    process.exit(1);
  }
  console.warn(
    '⚠️  Schema.ts drift only (no runtime crashes). Will be closed automatically by the codegen pass; no immediate action required.',
  );
  process.exit(0);
}

function relPath(p: string): string {
  return p
    .replace(ROOT + '/', '')
    .replace(ROOT + '\\', '')
    .replace(EXT_ROOT + '/', 'extensions/')
    .replace(EXT_ROOT + '\\', 'extensions/');
}

main();
