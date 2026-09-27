import { describe, it, expect, beforeAll } from 'bun:test';

// hashApiKey requires BETTER_AUTH_SECRET — set it before importing
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters!';
});

const { generateApiKey, hashApiKey } = await import('../../lib/security/api-key-hash.js');
const { findApiKey } = await import('../../lib/data/auth.js');

describe('hashApiKey', () => {
  it('returns a 64-character hex string', async () => {
    const hash = await hashApiKey('test-key-123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input produces same hash', async () => {
    const a = await hashApiKey('my-api-key');
    const b = await hashApiKey('my-api-key');
    expect(a).toBe(b);
  });

  it('produces different hashes for different keys', async () => {
    const a = await hashApiKey('key-one');
    const b = await hashApiKey('key-two');
    expect(a).not.toBe(b);
  });
});

describe('findApiKey: the key shape is checked before the lookup', () => {
  /** A db that counts lookups and finds nothing. */
  function countingDb() {
    const seen = { queries: 0 };
    const q = {
      selectAll: () => q,
      where: () => q,
      executeTakeFirst: async () => {
        seen.queries++;
        return undefined;
      },
    };
    return { db: { selectFrom: () => q } as never, seen };
  }

  it('costs a malformed key no query', async () => {
    for (const bogus of [
      'zvk_',
      'zvk_not_a_real_key',
      `zvk_${'a'.repeat(31)}`,
      `zvk_${'a'.repeat(33)}`,
      `zvk_${'A'.repeat(32)}`,
      `zvk_${'g'.repeat(32)}`,
    ]) {
      const { db, seen } = countingDb();
      expect(await findApiKey(db, bogus)).toBeNull();
      expect(seen.queries).toBe(0);
    }
  });

  it('looks up the shape the engine mints', async () => {
    const minted = generateApiKey();
    expect(minted).toMatch(/^zvk_[0-9a-f]{32}$/);
    const { db, seen } = countingDb();
    expect(await findApiKey(db, minted)).toBeNull();
    expect(seen.queries).toBe(1);
  });
});
