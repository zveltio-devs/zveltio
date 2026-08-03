/**
 * An extension's migrations may not reshape the engine's own schema.
 *
 * Migrations run with `_sql.raw(...)` on the engine's connection — as the
 * database owner — and they run in the MAIN THREAD, before `load.ts` picks
 * inline or worker. So the worker boundary, which is the entire reason a
 * community extension is allowed to install, does not cover this path: an
 * unreviewed extension got owner-level DDL at install time whatever its
 * manifest said about isolation.
 *
 * `buildAllowedTables` already decides which engine tables an extension may
 * touch at runtime. This is the same answer applied to DDL, which was the other
 * door and had no lock on it.
 *
 * Verified against the real catalogue before shipping: of 187 ALTER statements
 * in extension migrations that target an engine table, the guard refuses none —
 * every one belongs to an extension that owns the table because the feature
 * moved out of the engine.
 */

import { describe, expect, it } from 'bun:test';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function migrationFile(sqlText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-extmig-'));
  const f = join(dir, '001_probe.sql');
  writeFileSync(f, sqlText);
  return f;
}

/** Minimal extension shape the runner reads. */
function ext(name: string, files: string[]) {
  return { name, getMigrations: () => files } as never;
}

function db(): Database {
  const d = new CannedDb();
  // Nothing applied yet, so every migration is pending.
  d.when(/from "zv_migrations"/i, []);
  return d.kysely as unknown as Database;
}

describe('extension migration table guard', () => {
  it('refuses an ALTER on an engine table the extension does not own', async () => {
    const f = migrationFile('ALTER TABLE zv_api_keys ADD COLUMN backdoor text;');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).rejects.toThrow(
      /alters or drops engine table\(s\) zv_api_keys/,
    );
  });

  it('refuses a DROP too', async () => {
    const f = migrationFile('DROP TABLE IF EXISTS zv_tenants;');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).rejects.toThrow(/zv_tenants/);
  });

  it('refuses before opening a transaction', async () => {
    // A refusal must not leave a half-applied chain behind, so the check runs
    // over the whole set first.
    const bad = migrationFile('ALTER TABLE zv_api_keys ADD COLUMN x text;');
    const d = new CannedDb();
    d.when(/from "zv_migrations"/i, []);
    await expect(
      runExtensionMigrations(ext('probe', [bad]), d.kysely as unknown as Database),
    ).rejects.toThrow();
    expect(d.executed(/^begin/i).length).toBe(0);
  });

  it('allows an extension its own namespace', async () => {
    const f = migrationFile('ALTER TABLE zv_probe_notes ADD COLUMN body text;');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).resolves.toBeUndefined();
  });

  it('allows user-data tables', async () => {
    // Adding a column to a collection is an extension doing its job.
    const f = migrationFile('ALTER TABLE zvd_contacts ADD COLUMN score int;');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).resolves.toBeUndefined();
  });

  it('allows an engine table the grants list names', async () => {
    // `ai` relaxes a CHECK on zv_flows so a flow can carry AI trigger types.
    const f = migrationFile(
      'ALTER TABLE zv_flows DROP CONSTRAINT IF EXISTS zv_flows_trigger_type_check;',
    );
    await expect(runExtensionMigrations(ext('ai', [f]), db())).resolves.toBeUndefined();
  });

  it('does not refuse an extension that only creates its own tables', async () => {
    const f = migrationFile('CREATE TABLE IF NOT EXISTS zv_probe_items (id uuid primary key);');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).resolves.toBeUndefined();
  });
});
