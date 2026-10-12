#!/usr/bin/env bun
/**
 * Generates the GA baseline: one migration that builds, on an empty database,
 * what the whole released beta chain builds — mechanically, from a database
 * that ran the chain, never by hand.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun packages/engine/scripts/gen-baseline.ts --release v3.0.0-beta.79
 *
 * DATABASE_URL names a server it may create databases on; two scratch databases
 * are built and dropped. `--release` is the tag whose chain this replaces, and
 * the shipped files must be exactly that tag's, with the same UP checksums: the
 * baseline is only true of the chain it was dumped from.
 *
 * The file is, in order:
 *   1. The header the runner reads (`parseBaseline`): the release, and every
 *      replaced file with its checksum.
 *   2. The roles the chain creates and the memberships it grants the connecting
 *      user — cluster objects, which pg_dump of one database does not carry.
 *      Taken from the chain's own text, wrapped so a role-less install degrades
 *      as the chain's DO blocks did.
 *   3. `pg_dump --section=pre-data`, the seed rows, `--section=post-data` — the
 *      order pg_dump restores in, so the rows go in before the triggers and
 *      row-level security that would otherwise judge them.
 *   4. The database-level settings the chain sets (`ALTER DATABASE ... SET`).
 *
 * pg_dump's session SETs become SET LOCAL: the runner executes the baseline in
 * one transaction on a pooled connection, and a session setting would outlive
 * it. `ALTER DEFAULT PRIVILEGES FOR ROLE <dumping user>` loses its FOR ROLE,
 * which makes it the connecting user's — what the chain wrote with current_user.
 *
 * Equivalence is not assumed: tests/harness/baseline-equivalence.test.ts builds
 * both and compares them.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SQL } from 'bun';
import {
  isNonTransactional,
  parseMigrationFile,
  splitSqlStatements,
} from '../src/db/migrations/index.js';
import {
  type TableData,
  createScratchDb,
  databaseSettings,
  dropScratchDb,
  migrate,
  pgDump,
  quoteIdent,
  readData,
  seeds,
  volatileColumns,
} from './lib/baseline.js';
import { SQL_DIR, migrationFiles } from './gen-embedded-migrations.js';

const ENGINE = join(import.meta.dir, '..');
const BASELINE_DIR = join(ENGINE, 'src', 'db', 'migrations', 'baseline');

/** Statements in the chain that act outside the database pg_dump reads. */
const CLUSTER_LEVEL =
  /\b(ALTER\s+SYSTEM|ALTER\s+ROLE|CREATE\s+DATABASE|COMMENT\s+ON\s+DATABASE|SECURITY\s+LABEL|CREATE\s+EVENT\s+TRIGGER)\b/i;

/**
 * `initDatabase()` creates an empty `zv_migrations` before any migration runs
 * (db/index.ts, `ensureMigrationsTable`), so a database the engine booted on is
 * not quite empty. The chain's `CREATE TABLE IF NOT EXISTS` skipped over it;
 * pg_dump's plain CREATE TABLE does not, so that one leftover is removed first —
 * only while it is empty, which on a database with no ledger it always is.
 */
const BOOT_LEFTOVER = `DO $$
BEGIN
  -- Nested: one expression naming a missing table fails to parse.
  IF to_regclass('public.zv_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.zv_migrations) THEN
      DROP TABLE public.zv_migrations;
    END IF;
  END IF;
END
$$`;

function upChecksum(content: string): string {
  return createHash('sha256').update(parseMigrationFile(content).up).digest('hex').slice(0, 16);
}

function git(args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd: join(ENGINE, '..', '..') });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

/** The chain this build ships, checked against the release it claims to be. */
async function replacedChain(release: string) {
  const files = migrationFiles().filter((f) => f.startsWith('sql/'));
  const chain = [];
  for (const path of files) {
    const filename = path.slice('sql/'.length);
    chain.push({
      version: Number.parseInt(filename, 10),
      filename,
      content: await Bun.file(join(SQL_DIR, filename)).text(),
    });
  }
  const rel = 'packages/engine/src/db/migrations/sql';
  const tagged = git(['ls-tree', '--name-only', release, `${rel}/`])
    .trim()
    .split('\n')
    .map((p) => p.slice(rel.length + 1))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const shipped = chain.map((c) => c.filename).sort();
  if (JSON.stringify(tagged) !== JSON.stringify(shipped)) {
    throw new Error(`the shipped chain is not ${release}'s: the baseline must replace exactly it`);
  }
  for (const c of chain) {
    const atTag = git(['show', `${release}:${rel}/${c.filename}`]);
    if (upChecksum(atTag) !== upChecksum(c.content)) {
      throw new Error(`${c.filename} differs from ${release}: an applied UP never changes`);
    }
  }
  return chain;
}

/** pg_dump statements made fit for one transaction on a pooled connection. */
function adapt(dump: string, dumpingUser: string): string[] {
  const body = dump
    .split('\n')
    .filter((l) => !/^\\(un)?restrict /.test(l))
    .join('\n');
  const out: string[] = [];
  for (const raw of splitSqlStatements(body)) {
    // pg_dump's own comments lead each statement; a function body's are inside it.
    const stmt = raw.replace(/^(?:--[^\n]*\n|\s*\n)*/, '').trim();
    if (stmt === '' || stmt.startsWith('--')) continue;
    if (/^SET (client_encoding|\w*_timeout) /.test(stmt)) continue;
    if (/^COMMENT ON EXTENSION /.test(stmt)) continue; // the extension script sets it
    if (/^SET \w+ = /.test(stmt)) {
      out.push(stmt.replace(/^SET /, 'SET LOCAL '));
      continue;
    }
    if (stmt.startsWith("SELECT pg_catalog.set_config('search_path', '', false)")) {
      out.push("SELECT pg_catalog.set_config('search_path', '', true)");
      continue;
    }
    const forRole = `ALTER DEFAULT PRIVILEGES FOR ROLE ${dumpingUser} `;
    if (stmt.startsWith(forRole)) {
      out.push(`ALTER DEFAULT PRIVILEGES ${stmt.slice(forRole.length)}`);
      continue;
    }
    if (/\bOWNER TO\b|\bFOR ROLE\b/.test(stmt)) {
      throw new Error(
        `pg_dump statement names a role this generator cannot place: ${stmt.slice(0, 120)}`,
      );
    }
    out.push(stmt);
  }
  return out;
}

/** The roles and memberships the chain creates, as statements that cannot fail the baseline. */
function rolesOf(chainUp: string): string[] {
  const roles = new Map<string, string>();
  for (const m of chainUp.matchAll(/\bCREATE ROLE (\w+)((?:\s+[A-Z]+)*)\s*;/g)) {
    const attrs = m[2].trim();
    if (roles.has(m[1]) && roles.get(m[1]) !== attrs) {
      throw new Error(`the chain creates role ${m[1]} twice with different attributes`);
    }
    roles.set(m[1], attrs);
  }
  const members = new Set(
    [...chainUp.matchAll(/GRANT (\w+) TO %I', current_user\)/g)].map((m) => m[1]),
  );
  const out: string[] = [];
  for (const [role, attrs] of roles) {
    out.push(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role}${attrs ? ` ${attrs}` : ''};
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'zveltio: role ${role} not created (%)', SQLERRM;
END
$$`);
  }
  for (const role of members) {
    if (!roles.has(role)) throw new Error(`the chain grants ${role}, which it never creates`);
    out.push(`DO $$
BEGIN
  EXECUTE pg_catalog.format('GRANT ${role} TO %I', current_user);
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation OR undefined_object THEN
  RAISE NOTICE 'zveltio: ${role} not granted to %: %', current_user, SQLERRM;
END
$$`);
  }
  return out;
}

function literal(v: string | null, type: string): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'::${type}`;
}

/** One INSERT per seeded table, the columns the chain does not reproduce left to their defaults. */
function seedInserts(tables: TableData[], volatile: Set<string>): string[] {
  return tables.map((t) => {
    const keep = t.columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !volatile.has(`${t.name}.${c.name}`));
    const values = t.rows
      .map((r) => `  (${keep.map(({ c, i }) => literal(r[i], c.type)).join(', ')})`)
      .join(',\n');
    return (
      `INSERT INTO public.${quoteIdent(t.name)} (${keep.map(({ c }) => quoteIdent(c.name)).join(', ')}) VALUES\n` +
      values
    );
  });
}

function dbSettingStatement(setting: string): string {
  const eq = setting.indexOf('=');
  const name = setting.slice(0, eq);
  const value = setting.slice(eq + 1).replace(/'/g, "''");
  return `DO $$
BEGIN
  EXECUTE pg_catalog.format('ALTER DATABASE %I SET %I TO %L', current_database(), '${name}', '${value}');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'zveltio: database setting ${name} not set (%)', SQLERRM;
END
$$`;
}

async function main(): Promise<void> {
  const release = process.argv[process.argv.indexOf('--release') + 1];
  if (!process.argv.includes('--release') || !release) {
    throw new Error('usage: gen-baseline.ts --release <tag whose chain the baseline replaces>');
  }
  const server = process.env.DATABASE_URL;
  if (!server) throw new Error('DATABASE_URL (a server this may create databases on) is required');

  const chain = await replacedChain(release);
  // Comments dropped: the chain's prose mentions CREATE ROLE and ALTER ROLE too.
  const chainUp = chain
    .map((c) => parseMigrationFile(c.content).up.replace(/--[^\n]*/g, ''))
    .join('\n');
  const cluster = CLUSTER_LEVEL.exec(chainUp);
  if (cluster)
    throw new Error(`the chain runs "${cluster[0]}", which this generator does not carry`);
  const version = Math.max(...chain.map((c) => c.version)) + 1;
  const filename = `${String(version).padStart(3, '0')}_ga_baseline.sql`;

  const names = [`zveltio_baseline_gen_${process.pid}_a`, `zveltio_baseline_gen_${process.pid}_b`];
  try {
    const [a, b] = [
      await createScratchDb(server, names[0]),
      await createScratchDb(server, names[1]),
    ];
    await migrate(a, { ignoreBaseline: true });
    await migrate(b, { ignoreBaseline: true });

    const conn = new SQL(a);
    const [{ user }] = await conn`SELECT current_user AS user`;
    await conn.close();

    const replaced = new Set(chain.map((c) => c.version));
    const seedA = seeds(await readData(a), replaced);
    const volatile = volatileColumns(seedA, seeds(await readData(b), replaced));

    const statements = [
      BOOT_LEFTOVER,
      ...rolesOf(chainUp),
      ...adapt(await pgDump(a, ['--section=pre-data']), user),
      ...seedInserts(seedA, volatile),
      ...adapt(await pgDump(a, ['--section=post-data']), user),
      ...(await databaseSettings(a)).map(dbSettingStatement),
    ];

    const header = [
      '-- GA BASELINE — generated by packages/engine/scripts/gen-baseline.ts; do not edit.',
      '--',
      `-- A fresh database runs this file instead of the ${chain.length} migrations below; a`,
      '-- database that ran all of them records it without running it; one that ran only',
      `-- some is refused and told to upgrade to ${release} first. See parseBaseline in`,
      '-- db/migrations/index.ts. It has no DOWN: below it is an empty database.',
      '--',
      `-- BASELINE OF ${release}`,
      ...chain.map((c) => `-- REPLACES ${c.filename} ${upChecksum(c.content)}`),
    ];
    const content = `${header.join('\n')}\n\n${statements.map((s) => `${s};`).join('\n\n')}\n`;

    const parsed = parseMigrationFile(content);
    if (parsed.down !== null || isNonTransactional(parsed.up)) {
      throw new Error('the dump contains a line the runner reads as -- DOWN or -- NO TRANSACTION');
    }
    const out = join(BASELINE_DIR, filename);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
    console.log(
      `[gen-baseline] ${filename}: ${statements.length} statements, replaces ${chain.length} ` +
        `files of ${release}; ${volatile.size} seed column(s) left to their defaults`,
    );
  } finally {
    for (const n of names) await dropScratchDb(server, n);
  }
}

await main();
process.exit(0);
