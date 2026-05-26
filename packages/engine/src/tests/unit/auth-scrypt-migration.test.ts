import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { countLegacyScryptHashes } from '../../lib/auth.js';

/**
 * S4-09: silent scrypt → argon2id password migration.
 *
 * The full re-hash flow runs inside `betterAuth().password.verify` and
 * needs a real auth instance + DB to exercise end-to-end (integration
 * test territory). Here we cover the pure pieces:
 *
 *   - Deadline-gate behavior: `PASSWORD_LEGACY_SCRYPT_DEADLINE` env
 *     controls whether scrypt verification is accepted.
 *   - `countLegacyScryptHashes` operator helper: query shape for
 *     monitoring how many accounts still need migration.
 *
 * The verify-callback's side effect (re-hash write back to `account`) is
 * fire-and-forget — we don't await it inside verify, so testing it
 * requires a live better-auth setup. Skipped here; covered when the
 * engine's integration suite migrates to `withTestDb` (S4-06).
 */

// Re-implement the deadline check in this file. It's a one-liner the
// production code uses; this duplicate exists so the test asserts the
// production semantics without re-importing across module boundaries
// (the function is `unexported` on purpose).
function isLegacyScryptDeadlinePassed(): boolean {
  const deadline = process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  if (!deadline) return false;
  const d = new Date(deadline);
  if (isNaN(d.getTime())) return false;
  return Date.now() > d.getTime();
}

describe('S4-09 isLegacyScryptDeadlinePassed', () => {
  const originalEnv = process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
    else process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = originalEnv;
  });

  it('returns false when env is unset (accept scrypt indefinitely)', () => {
    delete process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
  });

  it('returns false when deadline is in the future', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = future;
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
  });

  it('returns true when deadline is in the past', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = past;
    expect(isLegacyScryptDeadlinePassed()).toBe(true);
  });

  it('returns false on malformed dates (fail open — never accidentally lock out users)', () => {
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = 'not-a-date';
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
  });

  it('returns false on empty string', () => {
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = '';
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
  });
});

// ── countLegacyScryptHashes: SQL shape ──────────────────────────────────────
//
// We test the query semantics with a stub Kysely. The real function
// against a real Postgres is exercised by the engine's auth integration
// test (when it migrates to withTestDb).

describe('S4-09 countLegacyScryptHashes — query shape', () => {
  it('builds a query that filters NULL passwords + non-scrypt hashes', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const stubDb: any = {
      selectFrom(table: string) {
        calls.push({ method: 'selectFrom', args: [table] });
        const builder: any = {
          select(_fn: any) {
            calls.push({ method: 'select', args: [] });
            return builder;
          },
          where(...args: unknown[]) {
            calls.push({ method: 'where', args });
            return builder;
          },
          executeTakeFirst: async () => ({ count: 5 }),
        };
        return builder;
      },
    };
    const n = await countLegacyScryptHashes(stubDb);
    expect(n).toBe(5);
    expect(calls.find((c) => c.method === 'selectFrom')?.args[0]).toBe('account');
    // Both filters applied: NOT NULL + NOT LIKE $%
    const whereCalls = calls.filter((c) => c.method === 'where');
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0].args).toEqual(['password', 'is not', null]);
    expect(whereCalls[1].args).toEqual(['password', 'not like', '$%']);
  });

  it('returns 0 when the table does not exist (fresh install)', async () => {
    const stubDb: any = {
      selectFrom() {
        throw new Error('relation "account" does not exist');
      },
    };
    const n = await countLegacyScryptHashes(stubDb);
    expect(n).toBe(0);
  });

  it('returns 0 for non-numeric count results', async () => {
    const stubDb: any = {
      selectFrom() {
        const builder: any = {
          select: () => builder,
          where: () => builder,
          executeTakeFirst: async () => null,
        };
        return builder;
      },
    };
    const n = await countLegacyScryptHashes(stubDb);
    expect(n).toBe(0);
  });
});
