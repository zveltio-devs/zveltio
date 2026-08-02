/**
 * Extension migration table extraction (lib/extensions/register.ts buildAllowedTables).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { EXTENSION_TABLE_GRANTS, buildAllowedTables } from '../../lib/extensions/register.js';

describe('EXTENSION_TABLE_GRANTS', () => {
  it('declares known cross-namespace table grants', () => {
    expect(EXTENSION_TABLE_GRANTS['content/drafts']).toContain('zv_revisions');
    expect(EXTENSION_TABLE_GRANTS['developer/validation']).toContain('zv_validation_rules');
  });
});

describe('buildAllowedTables', () => {
  it('collects CREATE TABLE names from migration files (IF NOT EXISTS included)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const a = join(dir, '001.sql');
    const b = join(dir, '002.sql');
    writeFileSync(
      a,
      'CREATE TABLE IF NOT EXISTS zv_foo_a (id uuid);\nCREATE TABLE zv_foo_b (id uuid);',
    );
    writeFileSync(b, 'CREATE TABLE zvd_things (id uuid);');
    const tables = await buildAllowedTables([a, b], 'foo');
    expect([...tables].sort()).toEqual(['zv_foo_a', 'zv_foo_b', 'zvd_things']);
  });

  it('keeps a table named for the feature rather than the folder', async () => {
    // The installed catalogue does not follow `zv_<extname>_*` — extension
    // tables are named for what they hold, not the folder they ship in. The
    // clamp is "not an engine table", so a name like this is simply kept.
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const f = join(dir, '001.sql');
    writeFileSync(f, 'CREATE TABLE zv_geofence_rules (id uuid);');
    const tables = await buildAllowedTables([f], 'geospatial/postgis');
    expect([...tables]).toEqual(['zv_geofence_rules']);
  });

  it('gives an extension back a table the engine also declares, when granted', async () => {
    // Eleven extensions own a table the engine still creates in 001_initial
    // because the feature moved out of the engine. Measured, listed in
    // EXTENSION_TABLE_GRANTS, and they must keep working.
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const f = join(dir, '001.sql');
    writeFileSync(f, 'CREATE TABLE zv_approval_requests (id uuid);');
    const tables = await buildAllowedTables([f], 'workflow/approvals');
    expect([...tables]).toEqual(['zv_approval_requests']);
  });

  it('catches a schema-qualified engine table', async () => {
    // 001_initial writes `CREATE TABLE IF NOT EXISTS public.zv_tenants`, and a
    // `(\w+)` capture reads that as the table `public` — so the real name was
    // never in the protected set and the refusal below silently did nothing.
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const f = join(dir, '001.sql');
    writeFileSync(f, 'CREATE TABLE IF NOT EXISTS public.zv_tenants (id uuid);');
    const tables = await buildAllowedTables([f], 'foo');
    expect(tables.size).toBe(0);
  });

  it('refuses to grant an ENGINE table the extension names in its own migration', async () => {
    // The extension authored the file the grant is read from, so this was a
    // self-service permission: `IF NOT EXISTS` against a table the engine
    // already owns does nothing at all and still left the grant behind.
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const f = join(dir, '001.sql');
    writeFileSync(
      f,
      'CREATE TABLE zv_foo_ok (id uuid);\n' +
        'CREATE TABLE IF NOT EXISTS zv_api_keys (id uuid);\n' +
        'CREATE TABLE zv_tenants (id uuid);',
    );
    const tables = await buildAllowedTables([f], 'foo');
    expect([...tables]).toEqual(['zv_foo_ok']);
    expect(tables.has('zv_api_keys')).toBe(false);
    expect(tables.has('zv_tenants')).toBe(false);
  });

  it('still honours an explicit grant for an engine table', async () => {
    // EXTENSION_TABLE_GRANTS is the reviewed way in, and it must outrank the
    // refusal above — otherwise content/drafts loses `zv_revisions`.
    const dir = mkdtempSync(join(tmpdir(), 'zv-mig-'));
    const f = join(dir, '001.sql');
    writeFileSync(f, 'CREATE TABLE IF NOT EXISTS zv_revisions (id uuid);');
    const tables = await buildAllowedTables([f], 'content/drafts');
    expect(tables.has('zv_revisions')).toBe(true);
  });

  it('skips unreadable paths without throwing', async () => {
    const tables = await buildAllowedTables(['/no/such/migration.sql'], 'foo');
    expect(tables.size).toBe(0);
  });

  it('returns an empty set for an empty path list', async () => {
    expect((await buildAllowedTables([], 'foo')).size).toBe(0);
  });
});
