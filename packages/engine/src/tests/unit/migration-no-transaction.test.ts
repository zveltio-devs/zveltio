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
  timeoutAdvice,
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

describe('timeoutAdvice', () => {
  // SQLSTATE arrives on `errno` under Bun's SQL driver — `code` carries the
  // generic ERR_POSTGRES_SERVER_ERROR for every server-side failure, so a
  // reader that checked `code` would match nothing and stay silent forever.
  // These shapes were taken from real cancellations against Postgres 18.
  const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '55P03',
  });
  const statementTimeout = Object.assign(
    new Error('canceling statement due to statement timeout'),
    { code: 'ERR_POSTGRES_SERVER_ERROR', errno: '57014' },
  );

  it('explains a lock timeout as contention rather than a broken migration', () => {
    const out = timeoutAdvice(lockTimeout) ?? '';
    expect(out).toContain('not a fault in the migration');
    // The operator needs to find the holder, so hand them the query.
    expect(out).toContain('pg_stat_activity');
    // And must not be steered into simply waiting longer on a live instance.
    expect(out).toContain('maintenance window');
  });

  it('reports the lock timeout actually in force, not the default', () => {
    const prev = process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT;
    process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT = '90s';
    expect(timeoutAdvice(lockTimeout)).toContain('waited 90s');
    process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT = prev ?? '';
    if (prev === undefined) delete process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT;
    expect(timeoutAdvice(lockTimeout)).toContain('waited 5s');
  });

  it('names the env var when it is what cancelled the statement', () => {
    const prev = process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT;
    process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT = '30s';
    expect(timeoutAdvice(statementTimeout)).toContain('is set to "30s"');
    if (prev === undefined) delete process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT;
    else process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT = prev;
  });

  it('points at the server when nobody set the env var — the case this is really for', () => {
    const prev = process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT;
    delete process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT;
    const out = timeoutAdvice(statementTimeout) ?? '';
    // Telling someone to lower a variable they never set would send them
    // looking in the wrong place entirely.
    expect(out).toContain('is not set here');
    expect(out).toContain('SHOW statement_timeout');
    if (prev !== undefined) process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT = prev;
  });

  it('says nothing about anything else', () => {
    const undefinedColumn = Object.assign(new Error('column "x" does not exist'), {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '42703',
    });
    expect(timeoutAdvice(undefinedColumn)).toBeNull();
    expect(timeoutAdvice(new Error('plain'))).toBeNull();
    expect(timeoutAdvice(null)).toBeNull();
    expect(timeoutAdvice(undefined)).toBeNull();
  });

  it('is not fooled by the SQLSTATE landing on `code`, which is where it is not', () => {
    const wrongField = Object.assign(new Error('canceling statement'), { code: '55P03' });
    expect(timeoutAdvice(wrongField)).toBeNull();
  });
});
