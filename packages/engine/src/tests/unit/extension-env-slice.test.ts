import { afterEach, describe, expect, it } from 'bun:test';
import { buildExtensionConfig } from '../../lib/extensions/config.js';

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
});
