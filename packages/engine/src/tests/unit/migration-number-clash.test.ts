/**
 * Two migrations with one number are refused by the generator and the
 * embedded-migrations gate, by name — not discovered at boot as a "squashed
 * chain". See `migrationFiles` in scripts/gen-embedded-migrations.ts.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrationFiles } from '../../../scripts/gen-embedded-migrations.js';

const dir = mkdtempSync(join(tmpdir(), 'zv-mig-clash-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('migration numbers', () => {
  it('refuses two files sharing a number, naming both', () => {
    for (const f of ['046_a.sql', '047_from_pr_one.sql', '047_from_pr_two.sql']) {
      writeFileSync(join(dir, f), 'SELECT 1;');
    }
    expect(() => migrationFiles(dir)).toThrow(
      'Two migrations share a number: 047_from_pr_one.sql / 047_from_pr_two.sql',
    );
  });

  it('the shipped set has none', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });
});
