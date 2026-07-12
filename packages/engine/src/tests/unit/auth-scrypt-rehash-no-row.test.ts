/**
 * auth.ts — scrypt verify succeeds even when the re-hash account row is gone.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

const { verifyPassword, setAuthDbForTests } = _internalForTests;

function legacyScryptHash(keyHex = 'a'.repeat(128)): string {
  return `testsalt:${keyHex}`;
}

beforeEach(() => {
  delete process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  setAuthDbForTests(new CannedDb().kysely as unknown as Database);
});

afterEach(() => {
  setAuthDbForTests(null);
});

describe('verifyPassword — rehash with missing account row', () => {
  it('still returns true when the account row disappears before re-hash', async () => {
    const password = 'LegacyNoRow1!';
    const keyHex = 'd'.repeat(128);
    const hash = legacyScryptHash(keyHex);
    const db = new CannedDb();
    db.when(/from "account"/i, []);
    setAuthDbForTests(db.kysely as unknown as Database);

    const crypto = await import('crypto');
    const scryptSpy = spyOn(crypto, 'scryptSync').mockImplementation((pwd, salt, keylen) => {
      if (pwd === password && salt === 'testsalt') {
        return Buffer.from(keyHex, 'hex');
      }
      return Buffer.alloc(keylen as number);
    });
    try {
      expect(await verifyPassword({ hash, password })).toBe(true);
      await Bun.sleep(20);
      expect(db.executed(/update "account"/i)).toHaveLength(0);
    } finally {
      scryptSpy.mockRestore();
    }
  });
});
