/**
 * Password hash/verify + scrypt → argon2id migration (lib/auth.ts).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

const { hashPassword, verifyPassword, setAuthDbForTests, isLegacyScryptDeadlinePassed } =
  _internalForTests;

function legacyScryptHash(keyHex = 'a'.repeat(128)): string {
  return `testsalt:${keyHex}`;
}

async function withScryptMock(
  password: string,
  keyHex: string,
  run: () => Promise<void>,
): Promise<void> {
  const crypto = await import('crypto');
  const scryptSpy = spyOn(crypto, 'scryptSync').mockImplementation((pwd, salt, keylen) => {
    if (pwd === password && salt === 'testsalt') {
      return Buffer.from(keyHex, 'hex');
    }
    return Buffer.alloc(keylen as number);
  });
  try {
    await run();
  } finally {
    scryptSpy.mockRestore();
  }
}

let savedDeadline: string | undefined;
let savedArgonMem: string | undefined;
let savedArgonTime: string | undefined;

beforeEach(() => {
  savedDeadline = process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  savedArgonMem = process.env.ARGON_MEMORY_COST_KIB;
  savedArgonTime = process.env.ARGON_TIME_COST;
  delete process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  delete process.env.ARGON_MEMORY_COST_KIB;
  delete process.env.ARGON_TIME_COST;
  setAuthDbForTests(new CannedDb().kysely as unknown as Database);
});

afterEach(() => {
  if (savedDeadline === undefined) delete process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  else process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = savedDeadline;
  if (savedArgonMem === undefined) delete process.env.ARGON_MEMORY_COST_KIB;
  else process.env.ARGON_MEMORY_COST_KIB = savedArgonMem;
  if (savedArgonTime === undefined) delete process.env.ARGON_TIME_COST;
  else process.env.ARGON_TIME_COST = savedArgonTime;
  setAuthDbForTests(null);
});

describe('hashPassword + verifyPassword (argon2id)', () => {
  it('hashes and verifies argon2id passwords', async () => {
    const hash = await hashPassword('secret-pass');
    expect(hash.startsWith('$')).toBe(true);
    expect(await verifyPassword({ hash, password: 'secret-pass' })).toBe(true);
    expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false);
  });

  it('clamps invalid ARGON env vars to safe defaults', async () => {
    process.env.ARGON_MEMORY_COST_KIB = '50';
    process.env.ARGON_TIME_COST = '99';
    const hash = await hashPassword('clamp-me');
    expect(await verifyPassword({ hash, password: 'clamp-me' })).toBe(true);
  });
});

describe('verifyPassword (legacy scrypt)', () => {
  it('accepts a valid legacy scrypt hash and schedules rehash', async () => {
    const password = 'LegacyPass123!';
    const keyHex = 'a'.repeat(128);
    const hash = legacyScryptHash(keyHex);
    const db = new CannedDb();
    db.when(/from "account"/i, [{ id: 'acct-1', password: hash }]);
    db.whenAffected(/update "account"/i, 1);
    setAuthDbForTests(db.kysely as unknown as Database);

    await withScryptMock(password, keyHex, async () => {
      expect(await verifyPassword({ hash, password })).toBe(true);
      await db.waitFor(/update "account"/i);
      const update = db.executed(/update "account"/i)[0]!;
      expect(update.parameters).toContain(hash);
    });
  });

  it('returns false for malformed scrypt hashes', async () => {
    expect(await verifyPassword({ hash: 'nocolon', password: 'x' })).toBe(false);
    expect(await verifyPassword({ hash: ':onlykey', password: 'x' })).toBe(false);
    expect(await verifyPassword({ hash: 'onlysalt:', password: 'x' })).toBe(false);
  });

  it('returns false for wrong scrypt password', async () => {
    const keyHex = 'b'.repeat(128);
    const hash = legacyScryptHash(keyHex);
    await withScryptMock('right', 'a'.repeat(128), async () => {
      expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false);
    });
  });

  it('returns false when scryptSync throws', async () => {
    const crypto = await import('crypto');
    const scryptSpy = spyOn(crypto, 'scryptSync').mockImplementation(() => {
      throw new Error('scrypt unavailable');
    });
    try {
      const hash = legacyScryptHash();
      expect(await verifyPassword({ hash, password: 'any' })).toBe(false);
    } finally {
      scryptSpy.mockRestore();
    }
  });

  it('refuses scrypt after PASSWORD_LEGACY_SCRYPT_DEADLINE', async () => {
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hash = legacyScryptHash();
      expect(await verifyPassword({ hash, password: 'old' })).toBe(false);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Refusing legacy scrypt'))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still verifies when rehash update fails', async () => {
    const password = 'StillWorks1!';
    const keyHex = 'c'.repeat(128);
    const hash = legacyScryptHash(keyHex);
    const db = new CannedDb();
    db.when(/from "account"/i, [{ id: 'acct-1', password: hash }]);
    db.fail(/update "account"/i, new Error('db down'));
    setAuthDbForTests(db.kysely as unknown as Database);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withScryptMock(password, keyHex, async () => {
        expect(await verifyPassword({ hash, password })).toBe(true);
        await Bun.sleep(20);
      });
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Re-hash to argon2id'))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('isLegacyScryptDeadlinePassed (production)', () => {
  it('matches deadline semantics used by verifyPassword', () => {
    delete process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = new Date(Date.now() + 60_000).toISOString();
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = new Date(Date.now() - 60_000).toISOString();
    expect(isLegacyScryptDeadlinePassed()).toBe(true);
    process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE = 'not-a-date';
    expect(isLegacyScryptDeadlinePassed()).toBe(false);
  });
});
