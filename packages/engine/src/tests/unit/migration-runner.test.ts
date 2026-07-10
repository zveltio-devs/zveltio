/**
 * Unit coverage for extensions/migration-runner.ts — apply / roll back an
 * extension's SQL migrations.
 *
 * runExtensionMigrations reads real .sql files (via Bun.file) so the tests write
 * temp migrations; the DB is a CannedDb that answers the zv_migrations
 * dedupe-SELECT and records the UP + INSERT (and, for purge, the DOWN + DELETE).
 * No Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../db/index.js';
import { DownMissingError } from '../../lib/extensions/extension-errors.js';
import {
  purgeExtensionData,
  runExtensionMigrations,
} from '../../lib/extensions/migration-runner.js';
import { CannedDb } from './fixtures/canned-db.js';

const MIG_SELECT = /select .* from "zv_migrations"/i;
const MIG_INSERT = /insert into "zv_migrations"/i;
const MIG_DELETE = /delete from "zv_migrations"/i;

let dir: string;
let migPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
  migPath = join(dir, '001_init.sql');
  writeFileSync(migPath, 'CREATE TABLE ext_demo (id int);\n-- DOWN\nDROP TABLE ext_demo;\n');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: test double for ZveltioExtension
function fakeExt(migrations: string[]): any {
  return { name: 'demo', getMigrations: () => migrations };
}

describe('runExtensionMigrations', () => {
  it('does nothing when the extension has no migrations', async () => {
    const db = new CannedDb();
    await runExtensionMigrations(fakeExt([]), db.kysely as unknown as Database);
    expect(db.log.length).toBe(0);
  });

  it('skips a migration that is already applied (no transaction/insert)', async () => {
    const db = new CannedDb();
    db.when(MIG_SELECT, [{ id: 'already' }]); // dedupe-check finds it
    await runExtensionMigrations(fakeExt([migPath]), db.kysely as unknown as Database);
    expect(db.executed(MIG_INSERT).length).toBe(0);
  });

  it('applies a pending migration: runs UP and records the row with its DOWN', async () => {
    const db = new CannedDb();
    db.when(MIG_SELECT, []); // not yet applied
    db.when(MIG_INSERT, []);

    await runExtensionMigrations(fakeExt([migPath]), db.kysely as unknown as Database);

    // UP ran inside the transaction
    expect(db.executed(/create table ext_demo/i).length).toBe(1);
    // the zv_migrations row was inserted with the derived name + DOWN sql
    const inserts = db.executed(MIG_INSERT);
    expect(inserts.length).toBe(1);
    expect(inserts[0].parameters).toContain('ext:demo:001_init');
    expect(inserts[0].parameters.some((p) => String(p).includes('DROP TABLE ext_demo'))).toBe(true);
  });
});

describe('purgeExtensionData', () => {
  it('does nothing when the extension has no recorded migrations', async () => {
    const db = new CannedDb();
    db.when(MIG_SELECT, []);
    await purgeExtensionData('demo', db.kysely as unknown as Database);
    expect(db.executed(MIG_DELETE).length).toBe(0);
  });

  it('throws DownMissingError when a recorded migration has no DOWN', async () => {
    const db = new CannedDb();
    db.when(MIG_SELECT, [{ id: 1, name: 'ext:demo:001_init', down_sql: null }]);
    await expect(
      purgeExtensionData('demo', db.kysely as unknown as Database),
    ).rejects.toBeInstanceOf(DownMissingError);
    expect(db.executed(MIG_DELETE).length).toBe(0); // nothing dropped
  });

  it('rolls back each DOWN and deletes the rows', async () => {
    const db = new CannedDb();
    db.when(MIG_SELECT, [
      { id: 2, name: 'ext:demo:002', down_sql: 'DROP TABLE b;' },
      { id: 1, name: 'ext:demo:001', down_sql: 'DROP TABLE a;' },
    ]);
    db.when(MIG_DELETE, []);

    await purgeExtensionData('demo', db.kysely as unknown as Database);

    expect(db.executed(/drop table b/i).length).toBe(1);
    expect(db.executed(/drop table a/i).length).toBe(1);
    expect(db.executed(MIG_DELETE).length).toBe(2);
  });
});
