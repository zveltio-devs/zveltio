/**
 * fingerprintToken — the short, non-reversible id the license rotation history
 * records instead of the token itself.
 *
 * This file used to re-implement fingerprintToken (and a client-IP helper and
 * a token generator) locally and assert those copies, so a change to the real
 * function could not fail it. It imports the real one now; the copies of the
 * other two had no production counterpart left to pin and are gone.
 */
import { describe, expect, it } from 'bun:test';
import { fingerprintToken } from '../../lib/extensions/extension-license.js';

describe('S3-04 license rotation: fingerprintToken', () => {
  it('returns 16 hex chars (first 8 bytes of sha256)', async () => {
    const fp = await fingerprintToken('hello-world');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await fingerprintToken('same');
    const b = await fingerprintToken('same');
    expect(a).toBe(b);
  });

  it('changes when a single byte changes', async () => {
    const a = await fingerprintToken('abc');
    const b = await fingerprintToken('abd');
    expect(a).not.toBe(b);
  });

  it('produces a stable known value for the empty string', async () => {
    // sha256('') = e3b0c44298fc1c14...; first 8 bytes hex:
    const fp = await fingerprintToken('');
    expect(fp).toBe('e3b0c44298fc1c14');
  });
});
