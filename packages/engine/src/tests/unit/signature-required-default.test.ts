/**
 * Signature enforcement is on unless explicitly disabled.
 *
 * The gate used to read `=== 'true'`, so an operator who never set the variable
 * — i.e. almost everyone — installed extensions with no signature check at all.
 * It could not be flipped earlier because the registry's official publish path
 * did not sign, so requiring signatures would have blocked every install. That
 * is fixed; this pins the resulting default so it cannot silently regress to
 * opt-in.
 *
 * This imports the real gate from extension-download.ts rather than
 * reimplementing the expression: a local copy pins itself, not the shipped
 * code, and stays green through a regression in the actual line. Verified by
 * flipping the real `signaturesRequired()` to `=== 'true'` — this file failed
 * (5/5) — then reverting.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { signaturesRequired } from '../../lib/extensions/extension-download.js';

const KEY = 'REQUIRE_EXTENSION_SIGNATURES';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('REQUIRE_EXTENSION_SIGNATURES default', () => {
  it('requires signatures when the variable is unset', () => {
    delete process.env[KEY];
    expect(signaturesRequired()).toBe(true);
  });

  it('requires signatures when set to "true"', () => {
    process.env[KEY] = 'true';
    expect(signaturesRequired()).toBe(true);
  });

  it('only the exact string "false" disables the check', () => {
    process.env[KEY] = 'false';
    expect(signaturesRequired()).toBe(false);
  });

  it('does not treat other falsy-looking values as a disable', () => {
    // A typo must fail safe: enforcement stays ON.
    for (const v of ['0', 'no', 'off', 'False', 'FALSE', '', ' false ']) {
      process.env[KEY] = v;
      expect(signaturesRequired()).toBe(true);
    }
  });
});

describe('BUILTIN_KEYS', () => {
  it('ships the production registry key the live signatures are made with', async () => {
    // Enforcement is only meaningful if the compiled key matches the signer.
    // Live signatures from registry.zveltio.com carry keyId registry-prod-2026;
    // if this entry ever disappears, every install breaks rather than silently
    // degrading, so assert it is present.
    const { getTrustedKeys } = await import('../../lib/security/registry-keys.js');
    const keys = getTrustedKeys();
    expect(keys.some((k) => k.keyId === 'registry-prod-2026')).toBe(true);
  });
});
