/**
 * Extension migrations that opt out of the chain transaction.
 *
 * The chain is atomic by default and that is worth keeping: an extension
 * either installs or does not. The marker cuts the chain only where an author
 * asked for it, so the risk here is not that it fails loudly — it is that it
 * silently does nothing, or silently cuts a chain nobody meant to cut. Both
 * are what these tests watch for.
 *
 * The Postgres half — that CONCURRENTLY is refused inside a transaction block
 * and accepted outside one — is verified live; what is pinned here is which
 * path a chain takes and how its statements reach the driver.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../db/index.js';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import { CannedDb } from './fixtures/canned-db.js';

const MIG_SELECT = /select .* from "zv_migrations"/i;
const MIG_INSERT = /insert into "zv_migrations"/i;

let dir: string;
const p: Record<string, string> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zv-notx-'));

  p.plain = join(dir, '001_plain.sql');
  writeFileSync(
    p.plain,
    'CREATE TABLE ext_a (id int);\nCREATE TABLE ext_b (id int);\n-- DOWN\nDROP TABLE ext_a;\n',
  );

  p.marked = join(dir, '002_marked.sql');
  writeFileSync(
    p.marked,
    '-- NO TRANSACTION\nDROP INDEX IF EXISTS idx_ext_a;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ext_a ON ext_a(id);\n-- DOWN\nDROP INDEX IF EXISTS idx_ext_a;\n',
  );

  p.after = join(dir, '003_after.sql');
  writeFileSync(p.after, 'ALTER TABLE ext_a ADD COLUMN note text;\n-- DOWN\nSELECT 1;\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeExt(migrations: string[]): any {
  return { name: 'demo', getMigrations: () => migrations };
}

function freshDb(): CannedDb {
  const db = new CannedDb();
  db.when(MIG_SELECT, []); // nothing applied yet
  db.when(MIG_INSERT, []);
  return db;
}

describe('runExtensionMigrations — NO TRANSACTION segmentation', () => {
  it('sends an unmarked UP as a single blob, exactly as before', async () => {
    const db = freshDb();
    await runExtensionMigrations(fakeExt([p.plain]), db.kysely as unknown as Database);

    // Both CREATE TABLEs arrive in one execution — the raw multi-statement
    // form the chain has always used. Splitting an unmarked migration would be
    // a behaviour change nobody asked for.
    const creates = db.executed(/create table ext_a/i);
    expect(creates.length).toBe(1);
    expect(creates[0].sql).toContain('ext_b');
  });

  it('splits a marked UP into separate statements', async () => {
    const db = freshDb();
    await runExtensionMigrations(fakeExt([p.marked]), db.kysely as unknown as Database);

    // A multi-statement simple query is itself an implicit transaction block,
    // so sending the marked UP as one blob would have Postgres refuse
    // CONCURRENTLY just as surely as the explicit transaction being escaped.
    const drops = db.executed(/drop index if exists idx_ext_a/i);
    const creates = db.executed(/create index concurrently/i);
    expect(drops.length).toBe(1);
    expect(creates.length).toBe(1);
    expect(creates[0].sql).not.toContain('DROP INDEX');
  });

  it('still records the migration row, so a completed run is not repeated', async () => {
    const db = freshDb();
    await runExtensionMigrations(fakeExt([p.marked]), db.kysely as unknown as Database);

    const inserts = db.executed(MIG_INSERT);
    expect(inserts.length).toBe(1);
    expect(inserts[0].parameters).toContain('ext:demo:002_marked');
  });

  it('keeps file order across a mixed chain', async () => {
    const db = freshDb();
    await runExtensionMigrations(
      fakeExt([p.plain, p.marked, p.after]),
      db.kysely as unknown as Database,
    );

    const order = db.log
      .map((q) => q.sql)
      .filter((s) => /create table ext_a|create index concurrently|add column note/i.test(s));
    expect(order.length).toBe(3);
    expect(/create table ext_a/i.test(order[0])).toBe(true);
    expect(/create index concurrently/i.test(order[1])).toBe(true);
    expect(/add column note/i.test(order[2])).toBe(true);

    // All three recorded, so the cut chain does not lose bookkeeping.
    expect(db.executed(MIG_INSERT).length).toBe(3);
  });

  it('does not cut the chain for an extension that never uses the marker', async () => {
    const db = freshDb();
    await runExtensionMigrations(fakeExt([p.plain, p.after]), db.kysely as unknown as Database);

    // Nothing marked means nothing split: the ALTER is still one execution,
    // and neither UP was taken apart.
    expect(db.executed(/add column note/i).length).toBe(1);
    expect(db.executed(/create table ext_a/i)[0].sql).toContain('ext_b');
  });
});
