import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { buildExtensionConfig } from '../../lib/extensions/config.js';

/**
 * `ctx.config.vars` exists because six files across four extensions read
 * `process.env` directly, and an in-process extension doing that sees the
 * ENGINE's environment in full — `DATABASE_URL`, `BETTER_AUTH_SECRET`,
 * `FIELD_ENCRYPTION_KEY`. The rule is generic, and the names stay in the
 * extension: `ZVELTIO_EXT_<NAME>__<KEY>`, the name ending at the last `__`
 * (ADR 0030). The single-underscore spelling is not read (ADR 0063, v2 entry 6).
 */
const KEYS = [
  'ZVELTIO_EXT_SEARCH__MEILISEARCH_URL',
  'ZVELTIO_EXT_BILLING__STRIPE_WEBHOOK_SECRET',
  'ZVELTIO_EXT_FINANCE_BANKING__FOO',
  'ZVELTIO_EXT_ENVC__STRIPE_WEBHOOK_SECRET',
  'ZVELTIO_EXT_ENVC_STRIPE__WEBHOOK_SECRET',
  'ZVELTIO_EXT_ENVC_MODE',
  'ZVELTIO_EXT_RUNNER__TOKEN',
  'ZVELTIO_EXT_RUNNER_SOCKET',
  'ZVELTIO_EXT_MEMORY_MB',
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('ctx.config.vars', () => {
  it('hands an extension the keys under its own name, with the prefix stripped', () => {
    process.env.ZVELTIO_EXT_SEARCH__MEILISEARCH_URL = 'http://meili:7700';
    expect(buildExtensionConfig([], 'search').vars).toEqual({
      MEILISEARCH_URL: 'http://meili:7700',
    });
  });

  it('normalises a nested extension name the same way the table prefix does', () => {
    process.env.ZVELTIO_EXT_FINANCE_BANKING__FOO = 'bar';
    expect(buildExtensionConfig([], 'finance/banking').vars).toEqual({ FOO: 'bar' });
  });

  it('does not hand over the engine own secrets, or another extension keys', () => {
    process.env.ZVELTIO_EXT_BILLING__STRIPE_WEBHOOK_SECRET = 'whsec_x';
    const search = buildExtensionConfig([], 'search').vars;
    expect(search).not.toHaveProperty('DATABASE_URL');
    expect(search).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect(search).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
    expect(buildExtensionConfig([], 'billing').vars.STRIPE_WEBHOOK_SECRET).toBe('whsec_x');
  });

  it('is frozen, and empty rather than everything when no extension name is given', () => {
    expect(Object.isFrozen(buildExtensionConfig([], 'search').vars)).toBe(true);
    expect(buildExtensionConfig([]).vars).toEqual({});
  });

  it('hands each key to the one extension whose name precedes the last __, installed or not', () => {
    process.env.ZVELTIO_EXT_ENVC__STRIPE_WEBHOOK_SECRET = 'mine';
    process.env.ZVELTIO_EXT_ENVC_STRIPE__WEBHOOK_SECRET = 'theirs';
    expect(buildExtensionConfig([], 'envc').vars).toEqual({ STRIPE_WEBHOOK_SECRET: 'mine' });
    expect(buildExtensionConfig([], 'envc-stripe').vars).toEqual({ WEBHOOK_SECRET: 'theirs' });
  });

  it('does not read the single-underscore spelling, and names it for the operator', () => {
    process.env.ZVELTIO_EXT_ENVC_MODE = 'old';
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(buildExtensionConfig([], 'envc').vars).toEqual({});
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        'ZVELTIO_EXT_ENVC_MODE -> ZVELTIO_EXT_ENVC__MODE',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("gives an extension named runner its own keys and never the engine's", () => {
    process.env.ZVELTIO_EXT_RUNNER__TOKEN = 't';
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = '/run/x.sock';
    process.env.ZVELTIO_EXT_MEMORY_MB = '512';
    expect(buildExtensionConfig([], 'runner').vars).toEqual({ TOKEN: 't' });
    expect(buildExtensionConfig([], 'memory').vars).toEqual({});
  });
});
