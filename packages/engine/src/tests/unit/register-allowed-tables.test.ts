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
      'CREATE TABLE IF NOT EXISTS zv_foo (id uuid);\nCREATE TABLE zv_bar (id uuid);',
    );
    writeFileSync(b, 'CREATE TABLE zv_baz (id uuid);');
    const tables = await buildAllowedTables([a, b]);
    expect([...tables].sort()).toEqual(['zv_bar', 'zv_baz', 'zv_foo']);
  });

  it('skips unreadable paths without throwing', async () => {
    const tables = await buildAllowedTables(['/no/such/migration.sql']);
    expect(tables.size).toBe(0);
  });

  it('returns an empty set for an empty path list', async () => {
    expect((await buildAllowedTables([])).size).toBe(0);
  });
});
