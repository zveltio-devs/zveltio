/**
 * The `-- NO TRANSACTION` marker and the migration timeout settings.
 *
 * Both are mechanisms an author has to trust without being able to see them
 * work — the marker changes how a file executes, the timeouts change what
 * happens when a lock is contended, and neither is visible in the SQL. That is
 * the shape of every mechanism in this codebase that turned out to be inert,
 * so they get tests that fail if the behaviour goes away.
 *
 * The Postgres-side half (CONCURRENTLY genuinely running outside a transaction,
 * SET LOCAL genuinely reaching the session) is covered by the integration lane;
 * what is checked here is the parsing and validation that decide which path a
 * migration takes.
 */

import { describe, expect, it } from 'bun:test';
import {
  isNonTransactional,
  parseMigrationFile,
  timeoutSetting,
} from '../../db/migrations/index.js';

describe('isNonTransactional', () => {
  it('detects the marker on its own line', () => {
    expect(isNonTransactional('-- NO TRANSACTION\nCREATE INDEX CONCURRENTLY i ON t(a);')).toBe(
      true,
    );
  });

  it('is case- and spacing-tolerant, like the DOWN marker it mirrors', () => {
    expect(isNonTransactional('--no   transaction\nSELECT 1;')).toBe(true);
    expect(isNonTransactional('--  NO TRANSACTION  \nSELECT 1;')).toBe(true);
  });

  it('ignores the words inside prose, so a comment explaining the marker does not become one', () => {
    const prose = '-- This migration deliberately runs with NO TRANSACTION disabled.\nSELECT 1;';
    expect(isNonTransactional(prose)).toBe(false);
  });

  it('is absent by default — the transactional path stays the default', () => {
    expect(isNonTransactional('ALTER TABLE t ADD COLUMN c TEXT;')).toBe(false);
  });

  it('coexists with the DOWN marker without either swallowing the other', () => {
    const raw = '-- NO TRANSACTION\nCREATE INDEX CONCURRENTLY i ON t(a);\n-- DOWN\nDROP INDEX i;';
    const parsed = parseMigrationFile(raw);
    expect(parsed.down).toBe('DROP INDEX i;');
    expect(isNonTransactional(parsed.up)).toBe(true);
    // The DOWN half is not the marker's business — a rollback runs its own way.
    expect(isNonTransactional(parsed.down as string)).toBe(false);
  });
});

describe('timeoutSetting', () => {
  const VAR = 'ZVELTIO_TEST_TIMEOUT_PROBE';

  it('falls back when unset or empty', () => {
    delete process.env[VAR];
    expect(timeoutSetting(VAR, '5s')).toBe('5s');
    process.env[VAR] = '';
    expect(timeoutSetting(VAR, '5s')).toBe('5s');
    delete process.env[VAR];
  });

  it('accepts the Postgres interval literals an operator would reach for', () => {
    for (const v of ['0', '250ms', '5s', '2min', '30000']) {
      process.env[VAR] = v;
      expect(timeoutSetting(VAR, '5s')).toBe(v);
    }
    delete process.env[VAR];
  });

  it('rejects anything else rather than building SQL from it', () => {
    // The value is interpolated into `SET LOCAL lock_timeout = '...'` because
    // SET takes no parameters. A typo must stop the boot, and a quote must not
    // reach the statement at all.
    for (const v of ['5 seconds', "5s'; DROP TABLE zv_schema_versions; --", 'fast', '-1']) {
      process.env[VAR] = v;
      expect(() => timeoutSetting(VAR, '5s')).toThrow(/not a Postgres interval literal/);
    }
    delete process.env[VAR];
  });
});
