import { afterEach, describe, expect, it } from 'bun:test';
import { buildExtensionConfig } from '../../lib/extensions/config.js';
import { noteExtensionNames } from '../../lib/extensions/worker-sql-policy.js';

/**
 * `ctx.config.vars` exists because six files across four extensions read
 * `process.env` directly, and an in-process extension doing that sees the
 * ENGINE's environment in full — `DATABASE_URL`, `BETTER_AUTH_SECRET`,
 * `FIELD_ENCRYPTION_KEY`. That is more than any of them needed and a way around
 * the capability gate on `ctx.internals`: an extension wanting to decrypt
 * without declaring `secrets` could take the key and do it itself.
 *
 * Moving each extension's settings onto `ExtensionConfig` instead would have put
 * Stripe, Meilisearch and Twilio into the engine. The rule is generic instead,
 * and the names stay where they belong.
 */
const OWN = ['ZVELTIO_EXT_SEARCH_MEILISEARCH_URL', 'ZVELTIO_EXT_BILLING_STRIPE_WEBHOOK_SECRET'];

afterEach(() => {
  for (const k of OWN) delete process.env[k];
});

describe('ctx.config.vars', () => {
  it('hands an extension the keys under its own prefix, with the prefix stripped', () => {
    process.env.ZVELTIO_EXT_SEARCH_MEILISEARCH_URL = 'http://meili:7700';
    expect(buildExtensionConfig([], 'search').vars).toEqual({
      MEILISEARCH_URL: 'http://meili:7700',
    });
  });

  it('normalises a nested extension name the same way the table prefix does', () => {
    process.env.ZVELTIO_EXT_FINANCE_BANKING_FOO = 'bar';
    expect(buildExtensionConfig([], 'finance/banking').vars).toEqual({ FOO: 'bar' });
    delete process.env.ZVELTIO_EXT_FINANCE_BANKING_FOO;
  });

  // The whole point, stated as an assertion rather than a comment.
  it('does not hand over the engine own secrets, or another extension keys', () => {
    process.env.ZVELTIO_EXT_BILLING_STRIPE_WEBHOOK_SECRET = 'whsec_x';
    const search = buildExtensionConfig([], 'search').vars;
    expect(search).not.toHaveProperty('DATABASE_URL');
    expect(search).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect(search).not.toHaveProperty('FIELD_ENCRYPTION_KEY');
    expect(search).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
    expect(buildExtensionConfig([], 'billing').vars.STRIPE_WEBHOOK_SECRET).toBe('whsec_x');
  });

  it('is frozen, so an extension cannot write a value back for the next reader', () => {
    const vars = buildExtensionConfig([], 'search').vars;
    expect(Object.isFrozen(vars)).toBe(true);
  });

  it('is empty rather than everything when no extension name is given', () => {
    // A missing name must not degrade into "the whole environment" — that is the
    // failure this whole mechanism exists to prevent.
    expect(buildExtensionConfig([])).toHaveProperty('vars');
    expect(buildExtensionConfig([]).vars).toEqual({});
  });

  // The prefix is not delimited and the fold is not injective: `ZVELTIO_EXT_BILLING_STRIPE_X`
  // spells `billing`'s `STRIPE_X` and `billing-stripe`'s `X` alike. A key two
  // known extensions can both read is handed to neither.
  describe('a key another known extension could also own', () => {
    const KEYS = [
      'ZVELTIO_EXT_ENVA_STRIPE_WEBHOOK_SECRET',
      'ZVELTIO_EXT_ENVA_PLAIN',
      'ZVELTIO_EXT_ENVB_X_Y',
      'ZVELTIO_EXT_RUNNER_SOCKET',
      'ZVELTIO_EXT_RUNNER_UID_BASE',
      'ZVELTIO_EXT_MEMORY_MB',
    ];
    afterEach(() => {
      for (const k of KEYS) delete process.env[k];
    });

    it('is not read by a longer-named extension (enva-stripe reading enva webhook secret)', () => {
      process.env.ZVELTIO_EXT_ENVA_STRIPE_WEBHOOK_SECRET = 'whsec_x';
      process.env.ZVELTIO_EXT_ENVA_PLAIN = 'p';
      noteExtensionNames(['enva', 'enva-stripe']);
      expect(buildExtensionConfig([], 'enva-stripe').vars).toEqual({});
      expect(buildExtensionConfig([], 'enva/stripe').vars).toEqual({});
      // Nor by the shorter one: the operator's intent is not knowable.
      expect(buildExtensionConfig([], 'enva').vars).toEqual({ PLAIN: 'p' });
    });

    it('is read by neither of two names that fold the same (envb-x / envb_x)', () => {
      process.env.ZVELTIO_EXT_ENVB_X_Y = 'y';
      noteExtensionNames(['envb-x', 'envb_x']);
      expect(buildExtensionConfig([], 'envb-x').vars).toEqual({});
      expect(buildExtensionConfig([], 'envb_x').vars).toEqual({});
    });

    it("never hands an extension the engine's own ZVELTIO_EXT_* settings", () => {
      process.env.ZVELTIO_EXT_RUNNER_SOCKET = '/run/x.sock';
      process.env.ZVELTIO_EXT_RUNNER_UID_BASE = '60000';
      process.env.ZVELTIO_EXT_MEMORY_MB = '512';
      expect(buildExtensionConfig([], 'runner').vars).toEqual({});
      expect(buildExtensionConfig([], 'memory').vars).toEqual({});
    });
  });
});
