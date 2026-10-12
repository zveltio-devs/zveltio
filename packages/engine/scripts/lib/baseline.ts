/**
 * What the GA baseline generator (`scripts/gen-baseline.ts`) and its
 * equivalence test (`tests/harness/baseline-equivalence.test.ts`) share: build
 * a database through the chain or through the baseline, and read back what each
 * one holds — the schema as `pg_dump` prints it, and every row the migrations
 * seed.
 *
 * "Equivalent" has one definition, written here once: the same `pg_dump
 * --schema-only` after `normalizeDump`, the same database-level settings, and
 * the same seed rows once the columns the chain itself does not reproduce are
 * set aside (`volatileColumns`).
 */

import { SQL } from 'bun';
import { createDb } from '../../src/db/index.js';
import { type ChainOptions, runPending } from '../../src/db/migrations/index.js';

/** `url` with its database name replaced. */
export function dbUrl(serverUrl: string, name: string): string {
  const u = new URL(serverUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function createScratchDb(serverUrl: string, name: string): Promise<string> {
  const admin = new SQL(dbUrl(serverUrl, 'postgres'));
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }
  return dbUrl(serverUrl, name);
}

export async function dropScratchDb(serverUrl: string, name: string): Promise<void> {
  const admin = new SQL(dbUrl(serverUrl, 'postgres'));
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

/** Runs the engine's own runner, the way boot does (`ignoreBaseline` builds the beta chain). */
export async function migrate(url: string, opts: ChainOptions = {}): Promise<string[]> {
  const db = createDb(url);
  try {
    return await runPending(db, opts);
  } finally {
    await db.destroy();
  }
}

export async function pgDump(url: string, args: string[]): Promise<string> {
  const p = Bun.spawnSync(['pg_dump', '--no-owner', ...args, url]);
  if (p.exitCode !== 0) {
    throw new Error(`pg_dump ${args.join(' ')} failed: ${p.stderr.toString().trim()}`);
  }
  return p.stdout.toString();
}

/**
 * pg_dump's output minus what differs between two dumps of the same schema: the
 * random `\restrict` key and the version banner.
 */
export function normalizeDump(dump: string): string {
  return dump
    .split('\n')
    .filter((l) => !/^\\(un)?restrict /.test(l) && !/^-- Dumped (from|by) /.test(l))
    .join('\n');
}

/** Database-level settings (`ALTER DATABASE ... SET`), as `name=value`. */
export async function databaseSettings(url: string): Promise<string[]> {
  const db = new SQL(url);
  try {
    const rows: Array<{ setrole: number; setconfig: string[] }> = await db`
      SELECT setrole::int AS setrole, setconfig FROM pg_db_role_setting
       WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    if (rows.some((r) => r.setrole !== 0)) {
      throw new Error('a per-role database setting is not handled by the baseline generator');
    }
    return rows.flatMap((r) => r.setconfig).sort();
  } finally {
    await db.close();
  }
}

export interface Column {
  name: string;
  /** `format_type` with an empty search_path, so a type outside pg_catalog is qualified. */
  type: string;
  default: string | null;
}

export interface TableData {
  name: string;
  columns: Column[];
  /** Every value as text (or null), in column order. */
  rows: Array<Array<string | null>>;
}

/** Every non-empty table in `public`, generated columns left out. */
export async function readData(url: string): Promise<TableData[]> {
  const db = new SQL(url);
  try {
    return await db.begin(async (tx) => {
      await tx`SELECT pg_catalog.set_config('search_path', '', true)`;
      const cols: Array<{ rel: string; name: string; type: string; def: string | null }> = await tx`
        SELECT c.relname AS rel, a.attname AS name,
               pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
               pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
                                       AND NOT a.attisdropped AND a.attgenerated = ''
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
         WHERE c.relkind IN ('r', 'p')
         ORDER BY c.relname, a.attnum`;
      const byTable = new Map<string, Column[]>();
      for (const c of cols) {
        byTable.set(c.rel, [
          ...(byTable.get(c.rel) ?? []),
          { name: c.name, type: c.type, default: c.def },
        ]);
      }
      const out: TableData[] = [];
      for (const [name, columns] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
        const list = columns.map((c) => `${quoteIdent(c.name)}::text`).join(', ');
        const rows = (await tx
          .unsafe(`SELECT ${list} FROM public.${quoteIdent(name)}`)
          .values()) as Array<Array<string | null>>;
        if (rows.length === 0) continue;
        out.push({ name, columns, rows });
      }
      return out;
    });
  } finally {
    await db.close();
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A default that produces a different value on every call. */
const VOLATILE_DEFAULT =
  /nextval\(|now\(\)|gen_random_uuid\(|random\(|clock_timestamp\(|CURRENT_TIMESTAMP/i;

/** Rows in a stable order: by every column whose default cannot vary, then the rest. */
function sortRows(t: TableData): Array<Array<string | null>> {
  const stable = t.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !(c.default && VOLATILE_DEFAULT.test(c.default)))
    .map(({ i }) => i);
  const key = (r: Array<string | null>) => JSON.stringify(stable.map((i) => r[i]));
  return [...t.rows].sort(
    (a, b) => key(a).localeCompare(key(b)) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

/**
 * `table.column` pairs whose seed values the chain itself does not reproduce:
 * every serial column, and every column with a volatile default whose values
 * differ between two independent builds `a` and `b` of the chain. A constant
 * the chain wrote over such a default (the default tenant's fixed id) is kept.
 *
 * Throws on a difference in any other column: a seed that is not reproducible
 * and not a default has no single right value to put in a baseline.
 */
export function volatileColumns(a: TableData[], b: TableData[]): Set<string> {
  const out = new Set<string>();
  const bByName = new Map(b.map((t) => [t.name, t]));
  if (a.length !== b.length || a.some((t) => !bByName.has(t.name))) {
    throw new Error('two builds of the chain seeded different tables');
  }
  for (const ta of a) {
    const tb = bByName.get(ta.name) as TableData;
    if (ta.rows.length !== tb.rows.length) {
      throw new Error(`two builds of the chain seeded ${ta.name} with different row counts`);
    }
    const ra = sortRows(ta);
    const rb = sortRows(tb);
    ta.columns.forEach((c, i) => {
      if (c.default?.includes('nextval(')) {
        out.add(`${ta.name}.${c.name}`);
        return;
      }
      if (ra.every((row, j) => row[i] === rb[j][i])) return;
      if (!(c.default && VOLATILE_DEFAULT.test(c.default))) {
        throw new Error(`${ta.name}.${c.name} differs between two builds of the chain`);
      }
      out.add(`${ta.name}.${c.name}`);
    });
  }
  return out;
}

/** `t` reduced to the columns not in `volatile`, rows in a stable order. */
export function stableProjection(t: TableData, volatile: Set<string>): TableData {
  const keep = t.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !volatile.has(`${t.name}.${c.name}`));
  const projected: TableData = {
    name: t.name,
    columns: keep.map(({ c }) => c),
    rows: t.rows.map((r) => keep.map(({ i }) => r[i])),
  };
  return { ...projected, rows: sortRows(projected) };
}

/**
 * The rows a build seeds: everything but the runner's own ledger. Of
 * `zv_schema_versions` only the rows no file records — 001's row for version 0.
 */
export function seeds(data: TableData[], ledgerVersions: Set<number>): TableData[] {
  return data
    .filter((t) => t.name !== 'zv_migrations')
    .map((t) => {
      if (t.name !== 'zv_schema_versions') return t;
      const v = t.columns.findIndex((c) => c.name === 'version');
      return { ...t, rows: t.rows.filter((r) => !ledgerVersions.has(Number(r[v]))) };
    })
    .filter((t) => t.rows.length > 0);
}
