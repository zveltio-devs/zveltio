/**
 * Signatures are always required: `REQUIRE_EXTENSION_SIGNATURES=false` is gone
 * (ADR 0056 amendment 2026-11-18) — extension-download-package.test.ts installs
 * nothing unsigned whatever it says. What is left to pin is the key the live
 * registry signs with.
 */

import { describe, expect, it } from 'bun:test';

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
