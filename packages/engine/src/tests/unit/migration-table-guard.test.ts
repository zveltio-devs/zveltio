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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

  it('refuses ALTER TABLE ONLY against a protected engine table', async () => {
    // `ALTER TABLE [IF EXISTS] [ONLY] name` is valid Postgres. Without an
    // allowance for "ONLY" between the optional clauses and the name, the
    // guard's `(\w+)` captured "ONLY" itself — a string that is never an
    // engine table — so it checked whether "only" was protected instead of
    // the real target, `zv_migrations`, and let the statement through.
    const f = migrationFile('ALTER TABLE ONLY zv_migrations DROP COLUMN down_sql;');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).rejects.toThrow(
      /alters or drops engine table\(s\) zv_migrations/,
    );
  });

  it('refuses ALTER TABLE IF EXISTS ONLY, schema-qualified', async () => {
    const f = migrationFile('ALTER TABLE IF EXISTS ONLY public.zv_tenants ADD COLUMN x text;');
    await expect(runExtensionMigrations(ext('probe', [f]), db())).rejects.toThrow(/zv_tenants/);
  });

  // ── Tables owned by ANOTHER extension ───────────────────────────
  //
  // The engine-table check is derived from the engine's own migration files, so
  // a table protects itself only while the engine still declares it. That makes
  // the protection disappear at exactly the wrong moment: moving a feature out
  // of the engine is what this codebase is doing, and the move itself is what
  // would unlock the table for everybody else.
  //
  // `zv_document_templates` is the case that already exists rather than a
  // hypothetical: `content/document-templates` creates it, the engine does not,
  // and `EXTENSION_TABLE_GRANTS` names `content/documents` as an owner.

  it('refuses an ALTER on a table another extension owns', async () => {
    const f = migrationFile('ALTER TABLE zv_document_templates ADD COLUMN sneaky text;');
    await expect(runExtensionMigrations(ext('ai', [f]), db())).rejects.toThrow(
      /zv_document_templates \(owned by content\/document-templates, content\/documents\)/,
    );
  });

  it('refuses a DROP of another extension’s table', async () => {
    const f = migrationFile('DROP TABLE IF EXISTS zv_document_templates;');
    await expect(runExtensionMigrations(ext('ai', [f]), db())).rejects.toThrow(
      /one extension must not reshape another's schema/,
    );
  });

  it('allows an owner named in the grants to alter it', async () => {
    const f = migrationFile('ALTER TABLE zv_document_templates ADD COLUMN body text;');
    await expect(
      runExtensionMigrations(ext('content/documents', [f]), db()),
    ).resolves.toBeUndefined();
  });

  it('allows a co-owner, because a table may have more than one', async () => {
    // `content/media` and `storage/cloud` share the media library, and both are
    // named on those tables. Being one of several owners is what grants access.
    const f = migrationFile('ALTER TABLE zv_media_files ADD COLUMN checksum text;');
    await expect(runExtensionMigrations(ext('storage/cloud', [f]), db())).resolves.toBeUndefined();
  });
});

// The guard is static, so the real first-party catalogue can be put through it
// without a database: `content/media` creates `zv_media_favorites`, the grants
// named only `storage/cloud` as its owner, and the media library could not be
// installed at all.
const CATALOGUE = join(import.meta.dir, '../../../../../../zveltio-extensions');
// Only a real checkout: CI's unit job has none, and there a bare directory of
// that name made the scan throw between tests.
const HAS_CATALOGUE = existsSync(join(CATALOGUE, 'package.json'));
describe.skipIf(!HAS_CATALOGUE)('first-party migrations meet the table guard', () => {
  // One to three levels (`crm`, `content/media`, `compliance/ro/saft`):
  // explicit depths, so the scan never walks node_modules.
  const manifests = HAS_CATALOGUE
    ? ['*', '*/*', '*/*/*']
        .flatMap((d) => [...new Bun.Glob(`${d}/manifest.json`).scanSync({ cwd: CATALOGUE })])
        .filter((p) => existsSync(join(CATALOGUE, dirname(p), 'engine/migrations')))
    : [];
  it.each(manifests)('%s', async (manifestPath) => {
    const dir = join(CATALOGUE, dirname(manifestPath));
    const { name } = JSON.parse(readFileSync(join(CATALOGUE, manifestPath), 'utf8')) as {
      name: string;
    };
    const files = [...new Bun.Glob('*.sql').scanSync({ cwd: join(dir, 'engine/migrations') })]
      .sort()
      .map((f) => join(dir, 'engine/migrations', f));
    const err = await runExtensionMigrations(ext(name, files), db()).then(
      () => null,
      (e: Error) => e.message,
    );
    // Anything past the guard fails on the canned database; only the guard's refusal counts.
    expect(err ?? '').not.toContain('has a migration that alters or drops');
  });
});
