/**
 * What a rotated `BETTER_AUTH_SECRET` does to what the old one signed (DR-17).
 *
 * docs/platform/security.md ("Rotating BETTER_AUTH_SECRET") tells operators
 * which artifacts expire harmlessly and which are destroyed. These cases pin
 * the engine side of that table: everything signed or sealed under the old
 * secret is refused under the new one — never trusted, never a thrown error
 * (a cache entry is a miss, a cursor restarts, a file URL is refused) — and the
 * two stored hashes no longer match, which is why every API key and every
 * extension token hash must be re-issued. Better Auth's own uses (session
 * cookies, the TOTP secret and backup codes) were run live; see the doc.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { openToken, sealToken } from '../../lib/data/query-parse.js';
import { hashApiKey } from '../../lib/security/api-key-hash.js';
import { hmacAuthSecret } from '../../lib/security/keyring.js';
import { signKey, verifySignedKey } from '../../lib/storage/local-driver.js';
import { decodeSigned, encodeSigned } from '../../lib/tenancy/signed-cache.js';

const OLD = 'old-secret-0123456789abcdef0123456789abcdef';
const NEW = 'new-secret-0123456789abcdef0123456789abcdef';
const previous = process.env.BETTER_AUTH_SECRET;
const previousList = process.env.BETTER_AUTH_SECRETS;
const rotate = (to: string) => {
  process.env.BETTER_AUTH_SECRET = to;
};

afterEach(() => {
  if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = previous;
  if (previousList === undefined) delete process.env.BETTER_AUTH_SECRETS;
  else process.env.BETTER_AUTH_SECRETS = previousList;
});

describe('rotating BETTER_AUTH_SECRET', () => {
  it('turns a signed cache entry into a miss, not a hit and not an error', () => {
    rotate(OLD);
    const raw = encodeSigned('rls', 'rls:policies:x', []);
    rotate(NEW);
    expect(decodeSigned('rls', 'rls:policies:x', raw)).toBeNull();
  });

  it('refuses a sealed list or sync cursor, which then restarts its walk', () => {
    rotate(OLD);
    const token = sealToken({ id: 'r1', val: 'b' }, 'aad');
    expect(openToken(token, 'aad')).toEqual({ id: 'r1', val: 'b' });
    rotate(NEW);
    expect(openToken(token, 'aad')).toBeUndefined();
  });

  it('refuses a signed file URL', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    rotate(OLD);
    const sig = signKey('uploads/a.txt', exp);
    rotate(NEW);
    expect(verifySignedKey('uploads/a.txt', exp, sig)).toBe(false);
  });

  it('changes the stored hash of an API key and of an extension token: both are destroyed', async () => {
    rotate(OLD);
    const key = await hashApiKey(`zvk_${'a'.repeat(32)}`);
    const token = await hmacAuthSecret('scim-token');
    rotate(NEW);
    expect(await hashApiKey(`zvk_${'a'.repeat(32)}`)).not.toBe(key);
    expect(await hmacAuthSecret('scim-token')).not.toBe(token);
  });
});

// ADR 0058 decision 7: with BETTER_AUTH_SECRETS, what the engine signs uses the
// list's current (first) secret only. BETTER_AUTH_SECRET=<old> stays set beside
// the list as Better Auth's legacy decrypt key, and must not keep keying these.
describe('BETTER_AUTH_SECRETS: engine signatures use the current secret only', () => {
  const listRotate = () => {
    rotate(OLD);
    process.env.BETTER_AUTH_SECRETS = `2:${NEW},1:${OLD}`;
  };

  it('refuses what the old secret signed, though it is still listed and still legacy', async () => {
    rotate(OLD);
    const raw = encodeSigned('rls', 'rls:policies:x', []);
    const token = sealToken({ id: 'r1' }, 'aad');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = signKey('uploads/a.txt', exp);
    const key = await hashApiKey(`zvk_${'a'.repeat(32)}`);
    listRotate();
    expect(decodeSigned('rls', 'rls:policies:x', raw)).toBeNull();
    expect(openToken(token, 'aad')).toBeUndefined();
    expect(verifySignedKey('uploads/a.txt', exp, sig)).toBe(false);
    expect(await hashApiKey(`zvk_${'a'.repeat(32)}`)).not.toBe(key);
  });

  it('signs with the current secret: the same as BETTER_AUTH_SECRET=<new> alone', async () => {
    listRotate();
    const raw = encodeSigned('rls', 'rls:policies:x', []);
    const key = await hashApiKey(`zvk_${'a'.repeat(32)}`);
    delete process.env.BETTER_AUTH_SECRETS;
    rotate(NEW);
    expect(decodeSigned('rls', 'rls:policies:x', raw)).toEqual([]);
    expect(await hashApiKey(`zvk_${'a'.repeat(32)}`)).toBe(key);
  });
});
