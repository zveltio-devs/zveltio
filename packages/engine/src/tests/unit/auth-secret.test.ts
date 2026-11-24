/**
 * BETTER_AUTH_SECRETS (ADR 0058 decision 7, DR-17): the parse, which secret is
 * current, and that Better Auth gets the list explicitly — a TOTP secret
 * encrypted under the old version still decrypts once the list names a new one.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Database } from '../../db/index.js';
import { getAuth, initAuth } from '../../lib/auth.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { currentAuthSecret, readAuthSecrets } from '../../lib/security/auth-secret.js';
import { CannedDb } from './fixtures/canned-db.js';

const OLD = 'old-secret-0123456789abcdef0123456789abcdef';
const NEW = 'new-secret-0123456789abcdef0123456789abcdef';

describe('readAuthSecrets', () => {
  it('takes BETTER_AUTH_SECRET alone as current and as Better Auth secret', () => {
    expect(readAuthSecrets({ BETTER_AUTH_SECRET: OLD })).toEqual({ current: OLD, legacy: OLD });
  });

  it('takes the FIRST list entry as current, not the highest version', () => {
    const env = { BETTER_AUTH_SECRETS: ` 2:${NEW} , 1:${OLD}` };
    expect(readAuthSecrets(env).current).toBe(NEW);
    expect(readAuthSecrets(env).secrets).toEqual([
      { version: 2, value: NEW },
      { version: 1, value: OLD },
    ]);
    expect(currentAuthSecret({ BETTER_AUTH_SECRETS: `1:${OLD},2:${NEW}` })).toBe(OLD);
  });

  it('beside the list, BETTER_AUTH_SECRET is only the legacy key', () => {
    const s = readAuthSecrets({ BETTER_AUTH_SECRET: OLD, BETTER_AUTH_SECRETS: `2:${NEW}` });
    expect(s.current).toBe(NEW);
    expect(s.legacy).toBe(OLD);
  });

  it('refuses a malformed list without echoing a secret', () => {
    for (const bad of [NEW, `x:${NEW}`, `-1:${NEW}`, '1:', `1:${NEW},`, `1:${NEW},1:${OLD}`, ' ']) {
      let message = '';
      try {
        readAuthSecrets({ BETTER_AUTH_SECRETS: bad });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/BETTER_AUTH_SECRETS entry \d/);
      expect(message).not.toContain('secret-0123');
      expect(() => currentAuthSecret({ BETTER_AUTH_SECRETS: bad })).toThrow();
    }
  });

  it('neither set: readAuthSecrets throws, currentAuthSecret is undefined', () => {
    expect(() => readAuthSecrets({})).toThrow(/BETTER_AUTH_SECRET/);
    expect(currentAuthSecret({})).toBeUndefined();
  });
});

describe('initAuth with BETTER_AUTH_SECRETS', () => {
  const saved = {
    single: process.env.BETTER_AUTH_SECRET,
    list: process.env.BETTER_AUTH_SECRETS,
  };
  const use = (single: string | undefined, list: string | undefined) => {
    if (single === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = single;
    if (list === undefined) delete process.env.BETTER_AUTH_SECRETS;
    else process.env.BETTER_AUTH_SECRETS = list;
  };
  afterEach(() => use(saved.single, saved.list));

  const secretConfig = async () => {
    _setCacheForTests(null);
    await initAuth(new CannedDb().kysely as unknown as Database);
    return (await getAuth().$context).secretConfig;
  };

  it('decrypts a TOTP secret written under the old version once the list names a new one', async () => {
    use(undefined, `1:${OLD}`);
    const v1 = await symmetricEncrypt({ key: await secretConfig(), data: 'JBSWY3DPEHPK3PXP' });
    expect(v1.startsWith('$ba$1$')).toBe(true);

    use(undefined, `2:${NEW},1:${OLD}`);
    const key = await secretConfig();
    expect(await symmetricDecrypt({ key, data: v1 })).toBe('JBSWY3DPEHPK3PXP');
    // Passed, not left to Better Auth's own read of the same variable.
    expect(getAuth().options.secrets).toEqual([
      { version: 2, value: NEW },
      { version: 1, value: OLD },
    ]);
    // New values are written under the current (first) version.
    expect((await symmetricEncrypt({ key, data: 'x' })).startsWith('$ba$2$')).toBe(true);
  });

  it('decrypts a value written before the list with BETTER_AUTH_SECRET as the legacy key', async () => {
    use(OLD, undefined);
    const bare = await symmetricEncrypt({ key: await secretConfig(), data: 'JBSWY3DPEHPK3PXP' });
    expect(bare.startsWith('$ba$')).toBe(false);

    use(OLD, `2:${NEW}`);
    expect(await symmetricDecrypt({ key: await secretConfig(), data: bare })).toBe(
      'JBSWY3DPEHPK3PXP',
    );
  });

  it('refuses to start on a malformed list', async () => {
    use(OLD, `2${NEW}`);
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).rejects.toThrow(
      /BETTER_AUTH_SECRETS entry 1/,
    );
  });
});
