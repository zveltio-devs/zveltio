#!/usr/bin/env bun
/**
 * Does this INSERT match the table it writes to?
 *
 * Ten extensions were examined at the seam between their code and their own
 * migrations. **Nine had a defect that stops or corrupts their primary
 * function** — POS could not record a sale, `finance/banking` could not import a
 * statement, `finance/subscriptions` could not create a subscriber or issue an
 * invoice, a document template could not be created, a recurring invoice could
 * not generate. Every one of them was the same shape:
 *
 *   * a column named in the INSERT that the table does not have
 *   * a NOT NULL column with no default that the INSERT never supplies
 *   * a column list and a value list of different lengths
 *   * a literal outside the CHECK constraint on that column
 *
 * None of it is subtle, and none of it was caught, because nothing ever stood at
 * that seam. TypeScript cannot: these are strings. The tests could not: they run
 * against mocks, or against a database some other migration had already shaped.
 *
 * So this stands there. It applies each extension's real migrations to a scratch
 * database — the same thing a customer's first install does — and then reads the
 * schema back out of `information_schema`, which is the only authority on what a
 * table actually looks like. It never parses SQL to decide what a column is; it
 * parses SQL only to find out what the code CLAIMS, and asks PostgreSQL whether
 * that claim holds.
 *
 * Usage:
 *   bun run scripts/check-insert-schema-match.ts [--ext <path>] [--verbose]
 *
 * Needs a PostgreSQL it can create databases on: PGHOST/PGUSER/PGPASSWORD, or
 * SEAM_DATABASE_URL. Without one it exits 0 with a note.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SQL } from 'bun';
// One definition of "the database a real install produces", shared with
// `schema-snapshot.ts`. A second copy of "apply the migrations in order" is
// exactly the drift this repo keeps paying for.
import {
  ADMIN_URL,
  EXT_ROOT,
  ROOT,
  buildInstallTemplate,
  dbUrl,
  extensionDirs,
  upHalf,
} from './lib/install-template.js';

const BASELINE = join(ROOT, 'quality-gates', 'insert-schema-match.json');
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => {
  const i = process.argv.indexOf('--ext');
  return i === -1 ? null : (process.argv[i + 1] ?? null);
})();

// ─── The engine schema, built once ───────────────────────────────────────────
// An extension's migrations are written to run after the engine's, and they
// lean on it: foreign keys to `user`, `zv_settings`, `zv_media_folders`, and
// `zveltio_tenant_scope_ok()` in every RLS policy.
//
// The first version of this stubbed those by hand and got it wrong in a way
// worth recording: the stub declared `zveltio_tenant_scope_ok(uuid)` only, so
// `billing` failed with "function zveltio_tenant_scope_ok(text) does not exist"
// and looked like a broken extension. The engine defines BOTH overloads. Four
// extensions were mis-blamed and twenty were skipped entirely.
//
// So: apply the engine's real migrations once into a template database, and
// clone it per extension. `CREATE DATABASE … TEMPLATE` is a file copy, so 54
// clones cost about what one migration run costs, and nothing is guessed.
const TEMPLATE_DB = `zveltio_seam_base_${process.pid}`;

/** The full-install template, built by the shared helper. */
async function buildTemplate(admin: SQL): Promise<string[]> {
  return buildInstallTemplate(admin, TEMPLATE_DB);
}

interface ColumnInfo {
  name: string;
  nullable: boolean;
  hasDefault: boolean;
  isGenerated: boolean;
}
interface TableInfo {
  columns: Map<string, ColumnInfo>;
  /** column → the literal values a CHECK constraint permits, when it is a
   *  plain `IN (...)` or a chain of `=` — the shape used for status columns. */
  allowedLiterals: Map<string, Set<string>>;
}

interface Finding {
  ext: string;
  file: string;
  line: number;
  kind: string;
  detail: string;
}

// ─── Reading what the code claims ────────────────────────────────────────────

/**
 * Replace every `${…}` with a single `?`, respecting nested braces, template
 * literals and strings inside the expression.
 *
 * Written by hand rather than with a regex because `${sql`…`}` nests, and a
 * regex that stops at the first `}` silently truncates the statement — which
 * would make this tool report columns the code does supply as missing.
 */
function maskPlaceholders(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === "'" || ch === '"' || ch === '`') {
          const quote = ch;
          j++;
          while (j < src.length && src[j] !== quote) {
            if (src[j] === '\\') j++;
            j++;
          }
        }
        j++;
      }
      out += '?';
      i = j;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/** Split a parenthesised list on top-level commas only. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === "'") {
      cur += ch;
      i++;
      while (i < list.length && list[i] !== "'") cur += list[i++];
      cur += "'";
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

/** Read the balanced parenthesised group starting at `open`. */
function readGroup(src: string, open: number): { body: string; end: number } | null {
  if (src[open] !== '(') return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'") {
      i++;
      while (i < src.length && src[i] !== "'") i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/**
 * `UPDATE <table> SET a = …, b = …` — the column names it assigns.
 *
 * The gate read only INSERTs at first, and `operations/inventory` had a PATCH
 * assigning `unit_cost`, `unit_price` and `reorder_quantity` on a table whose
 * columns are `cost_price`, `sale_price` and `reorder_qty` — the API names, used
 * as column names. Its own create route maps them correctly two screens up.
 * Every edit of a product answered 500, and the gate ran clean over it.
 *
 * Stops at the first keyword that ends the SET list. Qualified assignments like
 * `zvd_stock_levels.quantity = …` inside an ON CONFLICT clause are skipped: the
 * table there is not necessarily this statement's target.
 */
function findUpdates(src: string): InsertSite[] {
  const masked = stripSqlComments(maskPlaceholders(sqlTemplateBodies(src)));
  const sites: InsertSite[] = [];
  const re = /\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?"?([a-zA-Z_][\w]*)"?\s+SET\s+/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
  while ((m = re.exec(masked)) !== null) {
    const table = m[1]!;
    const rest = masked.slice(m.index + m[0].length);
    const stop = /\b(?:WHERE|RETURNING|FROM|ON\s+CONFLICT)\b/i.exec(rest);
    const body = rest.slice(0, stop ? stop.index : Math.min(rest.length, 2000));
    const columns: string[] = [];
    const values: string[] = [];
    for (const part of splitTopLevel(body)) {
      const a = /^\s*"?([a-zA-Z_][\w]*)"?\s*=\s*([\s\S]*)$/.exec(part);
      if (!a) continue;
      columns.push(a[1]!);
      values.push(a[2]!.trim());
    }
    if (columns.length === 0) continue;
    sites.push({
      table,
      columns,
      // Not an arity check — the lists are the same length by construction. This
      // carries the assigned values so a literal outside a CHECK domain is caught
      // on UPDATE too. `status = 'refunded'` on a domain of (open, paid, voided)
      // is how POS refunds failed, and reading only INSERTs missed it.
      valueGroups: [values],
      line: masked.slice(0, m.index).split('\n').length,
      hasOnConflict: false,
    });
  }
  return sites;
}

interface InsertSite {
  table: string;
  columns: string[];
  /** null when the statement is `INSERT … SELECT`, where counting is meaningless. */
  valueGroups: string[][] | null;
  line: number;
  hasOnConflict: boolean;
}

/**
 * Blank out SQL line comments, keeping every newline so line numbers survive.
 *
 * This is not cosmetic. `hr/payroll` has a nine-line `--` comment INSIDE its
 * VALUES list, and that prose contains commas. Counting commas without removing
 * it reported 27 values against 25 columns on a statement that is correct —
 * caught only by counting the list by hand, which is the reason to do that.
 */
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length && sql[i] !== "'") out += sql[i++];
      if (i < sql.length) out += sql[i++];
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The bodies of `sql` tagged templates, with everything else blanked out.
 *
 * Searching the whole file for `INSERT INTO` also matches the word inside a
 * JavaScript comment or a documentation string, and those are not statements
 * anyone runs. Newlines are preserved so reported line numbers are the file's.
 */
function sqlTemplateBodies(src: string): string {
  let out = '';
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const m = /\bsql(?:\.raw)?(?:<[^>]*>)?\s*`/.exec(src.slice(i));
    if (!m) {
      out += blank(src.slice(i));
      break;
    }
    const start = i + m.index + m[0].length;
    out += blank(src.slice(i, start));
    // Find the closing backtick, stepping over `${…}` which may contain one.
    let j = start;
    for (;;) {
      if (j >= src.length) break;
      const ch = src[j]!;
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '$' && src[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < src.length && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        continue;
      }
      if (ch === '`') break;
      j++;
    }
    out += src.slice(start, j);
    i = j;
    if (i < src.length) {
      out += ' ';
      i++;
    }
  }
  return out;
}

function findInserts(src: string): InsertSite[] {
  const masked = stripSqlComments(maskPlaceholders(sqlTemplateBodies(src)));
  const sites: InsertSite[] = [];
  const re = /\bINSERT\s+INTO\s+(?:public\.)?"?([a-zA-Z_][\w]*)"?\s*/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
  while ((m = re.exec(masked)) !== null) {
    const table = m[1]!;
    const afterName = m.index + m[0].length;
    const group = readGroup(masked, afterName);
    if (!group) continue; // `INSERT INTO t SELECT …` — no column list to check
    const columns = splitTopLevel(group.body).map((c) => c.replace(/["\s]/g, ''));
    if (columns.length === 0 || columns.some((c) => c === '' || c === '?')) continue;

    const rest = masked.slice(group.end + 1);
    const line = masked.slice(0, m.index).split('\n').length;
    const hasOnConflict = /^\s*[\s\S]{0,4000}?\bON\s+CONFLICT\b/i.test(rest.slice(0, 4000));

    const valuesAt = /^\s*VALUES\s*/i.exec(rest);
    if (!valuesAt) {
      sites.push({ table, columns, valueGroups: null, line, hasOnConflict });
      continue;
    }
    // Walk each `( … )` tuple after VALUES.
    const groups: string[][] = [];
    let pos = valuesAt[0].length;
    for (;;) {
      while (pos < rest.length && /\s|,/.test(rest[pos]!)) pos++;
      if (rest[pos] !== '(') break;
      const g = readGroup(rest, pos);
      if (!g) break;
      groups.push(splitTopLevel(g.body));
      pos = g.end + 1;
    }
    sites.push({
      table,
      columns,
      valueGroups: groups.length > 0 ? groups : null,
      line,
      hasOnConflict,
    });
  }
  return sites;
}

/**
 * Does this file's request validator leave `field` open?
 *
 * `operations/assets` declares `category: z.string().default('equipment')` while
 * `zvd_assets.category` has a CHECK listing seven values. Any other value passes
 * validation, reaches PostgreSQL, and answers 500 — measured live with
 * `"category":"IT"`. A closed domain in the database and an open one in the
 * validator is the same disagreement this whole file is about, one layer up.
 *
 * Scoped to the file rather than the handler: a `z.enum` anywhere in it for that
 * field is enough to call it constrained. That under-reports and never
 * over-reports, which is the right direction for a gate.
 */
function validatorIsOpen(src: string, field: string): boolean {
  const enumed = new RegExp(`\\b${field}\\s*:\\s*z\\.enum\\(`).test(src);
  if (enumed) return false;
  return new RegExp(`\\b${field}\\s*:\\s*z\\.string\\(\\)`).test(src);
}

/** A bare `'literal'` value, or null when it is a placeholder or expression. */
function literalOf(value: string): string | null {
  const t = value.trim();
  const m = /^'([^']*)'(?:::\w+)?$/.exec(t);
  return m ? m[1]! : null;
}

// ─── Reading what the database says ──────────────────────────────────────────

async function introspect(sql: SQL): Promise<Map<string, TableInfo>> {
  const cols = await sql<
    {
      table_name: string;
      column_name: string;
      is_nullable: string;
      column_default: string | null;
      is_generated: string;
      identity_generation: string | null;
    }[]
  >`SELECT table_name, column_name, is_nullable, column_default, is_generated, identity_generation
    FROM information_schema.columns WHERE table_schema = 'public'`;

  const checks = await sql<{ table_name: string; def: string }[]>`
    SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE con.contype = 'c' AND ns.nspname = 'public'`;

  const tables = new Map<string, TableInfo>();
  for (const c of cols) {
    let t = tables.get(c.table_name);
    if (!t) {
      t = { columns: new Map(), allowedLiterals: new Map() };
      tables.set(c.table_name, t);
    }
    t.columns.set(c.column_name, {
      name: c.column_name,
      nullable: c.is_nullable === 'YES',
      hasDefault: c.column_default !== null || c.identity_generation !== null,
      isGenerated: c.is_generated === 'ALWAYS',
    });
  }

  for (const ck of checks) {
    const t = tables.get(ck.table_name);
    if (!t) continue;
    // PostgreSQL normalises a status CHECK into one of:
    //   CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text])))        -- text column
    //   CHECK (((status)::text = ANY ((ARRAY['open'::character varying])::text[])))  -- varchar
    //   CHECK (((status)::text = 'open'::text))
    // The cast on the column appears only for varchar, which is why keying on
    // `::text` missed every `text` column — POS's own status CHECK among them.
    // Anything more complex than these is left alone rather than guessed at.
    const colMatch = /\(\(?"?([a-z_][\w]*)"?\)?(?:::text)?\s*=\s*(?:ANY|')/i.exec(ck.def);
    if (!colMatch) continue;
    const column = colMatch[1]!;
    const literals = [...ck.def.matchAll(/'([^']*)'(?:::(?:character varying|text))?/g)].map(
      (m) => m[1]!,
    );
    if (literals.length === 0) continue;
    const existing = t.allowedLiterals.get(column);
    // Two CHECKs on one column both have to hold, so intersect.
    t.allowedLiterals.set(
      column,
      existing ? new Set([...literals].filter((l) => existing.has(l))) : new Set(literals),
    );
  }
  return tables;
}

// ─── Driving it ──────────────────────────────────────────────────────────────

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.includes('.test.')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

async function main(): Promise<void> {
  if (!existsSync(EXT_ROOT)) {
    console.log('[insert-schema] SKIP — no sibling zveltio-extensions checkout.');
    return;
  }
  let admin: SQL;
  try {
    admin = new SQL(ADMIN_URL);
    await admin`SELECT 1`;
  } catch (err) {
    console.log(`[insert-schema] SKIP — no database to build against (${(err as Error).message}).`);
    return;
  }

  const dirs = extensionDirs(EXT_ROOT).filter((d) => !ONLY || d.includes(ONLY));
  const findings: Finding[] = [];
  const migrationErrors: string[] = [];
  let examined = 0;
  let insertSites = 0;

  migrationErrors.push(...(await buildTemplate(admin)));

  const dbName = `zveltio_seam_${process.pid}`;
  for (const dir of dirs) {
    const ext = dir.slice(EXT_ROOT.length + 1);
    const migDir = join(dir, 'engine', 'migrations');
    if (!existsSync(migDir)) continue;
    const migrations = readdirSync(migDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    if (migrations.length === 0) continue;

    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.unsafe(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
    const db = new SQL(dbUrl(dbName));
    try {
      for (const file of migrations) {
        const sqlText = upHalf(readFileSync(join(migDir, file), 'utf8'));
        try {
          await db.unsafe(sqlText);
        } catch (err) {
          migrationErrors.push(`${ext}/${file}: ${(err as Error).message.split('\n')[0]}`);
        }
      }
      const tables = await introspect(db);
      examined++;

      for (const file of tsFiles(join(dir, 'engine'))) {
        const rel = `${ext}/${file.slice(dir.length + 1)}`;
        const fileSrc = readFileSync(file, 'utf8');
        const updateLines = new Set(findUpdates(fileSrc).map((u) => u.line));
        for (const site of [...findInserts(fileSrc), ...findUpdates(fileSrc)]) {
          insertSites++;
          const table = tables.get(site.table);
          // A table this extension does not own — the engine's, or another
          // extension's. Out of scope: we only built this extension's schema.
          if (!table) continue;

          for (const col of site.columns) {
            if (!table.columns.has(col)) {
              findings.push({
                ext,
                file: rel,
                line: site.line,
                kind: 'no-such-column',
                detail: `${site.table} has no column "${col}"`,
              });
            }
          }

          if (site.valueGroups) {
            for (const values of site.valueGroups) {
              if (!updateLines.has(site.line) && values.length !== site.columns.length) {
                findings.push({
                  ext,
                  file: rel,
                  line: site.line,
                  kind: 'arity-mismatch',
                  detail: `${site.table}: ${site.columns.length} column(s), ${values.length} value(s)`,
                });
                continue;
              }
              for (let i = 0; i < site.columns.length; i++) {
                const col = site.columns[i]!;
                const allowed = table.allowedLiterals.get(col);
                const lit = literalOf(values[i]!);
                if (allowed && lit !== null && !allowed.has(lit)) {
                  findings.push({
                    ext,
                    file: rel,
                    line: site.line,
                    kind: 'check-violation',
                    detail: `${site.table}.${col} = '${lit}' is outside its CHECK (${[...allowed].sort().join(', ')})`,
                  });
                }
                // The value is a placeholder — so whatever the request carries
                // reaches a column with a closed domain. Ask what the validator
                // permits.
                if (allowed && allowed.size > 1 && lit === null && validatorIsOpen(fileSrc, col)) {
                  findings.push({
                    ext,
                    file: rel,
                    line: site.line,
                    kind: 'unconstrained-validator',
                    detail: `${site.table}.${col} accepts only (${[...allowed].sort().join(', ')}) but the validator declares it z.string() — any other value is a 500`,
                  });
                }
              }
            }
          }

          // Required columns — an INSERT question only. An UPDATE that does not
          // mention a NOT NULL column is leaving it alone, which is correct.
          if (updateLines.has(site.line)) continue;
          const supplied = new Set(site.columns);
          for (const c of table.columns.values()) {
            if (c.nullable || c.hasDefault || c.isGenerated) continue;
            if (supplied.has(c.name)) continue;
            findings.push({
              ext,
              file: rel,
              line: site.line,
              kind: 'missing-required',
              detail: `${site.table}.${c.name} is NOT NULL with no default and is never supplied`,
            });
          }
        }
      }
    } finally {
      await db.end();
    }
  }
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
  await admin.end();

  // ─── Report ────────────────────────────────────────────────────────────────
  if (VERBOSE && migrationErrors.length > 0) {
    console.log(`[insert-schema] ${migrationErrors.length} migration statement(s) did not apply:`);
    for (const e of migrationErrors.slice(0, 40)) console.log(`    ${e}`);
  }

  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.ext] = (counts[f.ext] ?? 0) + 1;

  const baseline: Record<string, number> = {};
  if (existsSync(BASELINE)) {
    const raw = readFileSync(BASELINE, 'utf8').trim();
    if (raw !== '') {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (!k.startsWith('_') && typeof v === 'number') baseline[k] = v;
      }
    }
  }

  const regressions = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0));
  if (regressions.length > 0 || VERBOSE) {
    const show = VERBOSE ? Object.keys(counts) : regressions.map(([k]) => k);
    for (const ext of show.sort()) {
      console.error(`\n  ${ext}`);
      for (const f of findings.filter((x) => x.ext === ext)) {
        console.error(`    ${f.file}:${f.line}  [${f.kind}] ${f.detail}`);
      }
    }
  }

  if (regressions.length > 0) {
    console.error(
      `\n[insert-schema] FAIL — ${regressions.length} extension(s) write rows their own migrations refuse.`,
    );
    console.error('This is the seam ten extensions were examined at; nine had a defect here.');
    process.exit(1);
  }

  const allowed = Object.values(baseline).reduce((a, b) => a + b, 0);
  console.log(
    `[insert-schema] OK — ${examined} extension(s) built, ${insertSites} INSERT site(s) checked against their own schema, ${findings.length} finding(s), baseline allows ${allowed}.`,
  );
}

await main();
