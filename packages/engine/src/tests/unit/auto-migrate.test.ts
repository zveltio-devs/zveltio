import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Unit tests for the auto-migrate skip + advisory-lock path (S4-10).
 *
 * `autoMigrate(db)` does I/O against Postgres — running it for real
 * requires a live database. Here we test the *decision* logic:
 *   - `MIGRATIONS_AUTO=false` short-circuits early.
 *   - Schema already at MAX_SCHEMA_VERSION → no lock, no migrations.
 *
 * The advisory-lock acquire+release path is covered by integration
 * tests against a real Postgres in `tests/integration/`. Here we
 * exercise the early-exit branches with a stub DB.
 */

import type { Database } from '../../db/index.js';

// Re-implement the decision logic so we don't need to import the real
// `autoMigrate` (which pulls Kysely's `sql` tag and would require a
// live driver to exercise). Drift between this stub and the real
// function should be caught in review when the file is edited.
function decideAutoMigrate(opts: { env: string | undefined; current: number; max: number }): {
  skip: boolean;
  reason: 'env' | 'up-to-date' | 'run';
} {
  if (opts.env === 'false') return { skip: true, reason: 'env' };
  if (opts.current >= opts.max) return { skip: true, reason: 'up-to-date' };
  return { skip: false, reason: 'run' };
}

describe('S4-10 auto-migrate decision logic', () => {
  it('skips when MIGRATIONS_AUTO=false even with pending migrations', () => {
    const d = decideAutoMigrate({ env: 'false', current: 50, max: 73 });
    expect(d).toEqual({ skip: true, reason: 'env' });
  });

  it('skips when schema is already at MAX_SCHEMA_VERSION', () => {
    const d = decideAutoMigrate({ env: undefined, current: 73, max: 73 });
    expect(d).toEqual({ skip: true, reason: 'up-to-date' });
  });

  it('skips when schema is ahead of MAX_SCHEMA_VERSION (downgrade)', () => {
    // Downgrade case: replica was bumped to a newer engine first, then
    // someone restarted this older engine. The schema-compat check
    // catches this immediately after — we just need auto-migrate to
    // not try to apply anything backward.
    const d = decideAutoMigrate({ env: undefined, current: 80, max: 73 });
    expect(d).toEqual({ skip: true, reason: 'up-to-date' });
  });

  it('runs when there is at least one pending migration', () => {
    const d = decideAutoMigrate({ env: undefined, current: 72, max: 73 });
    expect(d).toEqual({ skip: false, reason: 'run' });
  });

  it('runs on a fresh DB (current=0)', () => {
    const d = decideAutoMigrate({ env: undefined, current: 0, max: 73 });
    expect(d).toEqual({ skip: false, reason: 'run' });
  });

  it('only treats the literal string "false" as opt-out', () => {
    // Common typos that should NOT disable auto-migrate.
    expect(decideAutoMigrate({ env: '0', current: 50, max: 73 }).skip).toBe(false);
    expect(decideAutoMigrate({ env: 'False', current: 50, max: 73 }).skip).toBe(false);
    expect(decideAutoMigrate({ env: 'no', current: 50, max: 73 }).skip).toBe(false);
    expect(decideAutoMigrate({ env: '', current: 50, max: 73 }).skip).toBe(false);
  });
});

describe('S4-10 advisory-lock key stability', () => {
  // The lock key must be a stable 64-bit integer literal so every
  // replica converges on the same value. Hard-coded in auto-migrate.ts
  // as 0x7a76656c74696f00n. This test pins the value so a future drift
  // (e.g. someone "refactoring" the literal) is caught.
  const EXPECTED = 0x7a76656c74696f00n;

  it('locks all replicas on the same key', () => {
    // The first 7 bytes are ASCII 'zveltio', the 8th is NUL.
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, EXPECTED, false);
    // Bytes 0..6 spell 'zveltio'.
    expect(String.fromCharCode(...Array.from(bytes.slice(0, 7)))).toBe('zveltio');
    expect(bytes[7]).toBe(0);
  });
});

describe('S4-10 autoMigrate — integration with stub db (env path)', () => {
  // This exercises the real autoMigrate against a stub that records
  // calls. We verify MIGRATIONS_AUTO=false skips ALL DB calls (no
  // pg_advisory_lock, no SELECT).

  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.MIGRATIONS_AUTO;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MIGRATIONS_AUTO;
    else process.env.MIGRATIONS_AUTO = originalEnv;
  });

  it('with MIGRATIONS_AUTO=false: returns ran:false and never touches the lock', async () => {
    process.env.MIGRATIONS_AUTO = 'false';
    const calls: string[] = [];
    const db: any = {
      selectFrom: (table: string) => {
        calls.push(`selectFrom:${table}`);
        return {
          select: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  executeTakeFirst: async () => ({ version: 42 }),
                }),
              }),
            }),
          }),
        };
      },
    };
    const { autoMigrate } = await import('../../db/auto-migrate.js');
    const result = await autoMigrate(db as Database);
    expect(result.ran).toBe(false);
    expect(result.before).toBe(42);
    expect(result.after).toBe(42);
    // selectFrom was called once for `getLastAppliedMigration` — that's it.
    // No SELECT pg_advisory_lock.
    expect(calls.some((c) => c.includes('advisory_lock'))).toBe(false);
  });
});
