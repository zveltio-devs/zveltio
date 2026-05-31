import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';

/**
 * Trust chain unit tests — alpha.123 added archive SHA-256 verification
 * at install time. The full HTTP path is exercised by integration tests
 * that mount a real fetch shim; these tests pin the hash-compare logic
 * the loader runs after pulling the ZIP from the registry.
 *
 * We don't import `downloadExtension` directly because it pulls a long
 * chain of engine internals. Instead we replicate the exact compare
 * the loader does (`extension-loader.ts` ~390): SHA-256 the buffer,
 * lowercase the header, refuse on mismatch.
 */

function verifyArchiveSha(zipBytes: Buffer, declaredHash: string | null): void {
  if (!declaredHash) return;
  const actual = createHash('sha256').update(zipBytes).digest('hex');
  if (actual !== declaredHash.toLowerCase()) {
    throw new Error(
      `archive SHA-256 mismatch: declared ${declaredHash.slice(0, 12)}… ` +
        `but bytes hash to ${actual.slice(0, 12)}…`,
    );
  }
}

describe('archive SHA-256 verification (alpha.123 trust chain)', () => {
  it('accepts matching bytes + declared hash', () => {
    const bytes = Buffer.from('zveltio-test-package-bytes');
    const declared = createHash('sha256').update(bytes).digest('hex');
    expect(() => verifyArchiveSha(bytes, declared)).not.toThrow();
  });

  it('accepts uppercase-hex header (case-insensitive compare)', () => {
    const bytes = Buffer.from('zveltio-test-package-bytes');
    const declared = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    expect(() => verifyArchiveSha(bytes, declared)).not.toThrow();
  });

  it("refuses bytes that don't match the declared hash", () => {
    const bytes = Buffer.from('zveltio-test-package-bytes');
    const wrong = createHash('sha256').update('different-bytes').digest('hex');
    expect(() => verifyArchiveSha(bytes, wrong)).toThrow(/mismatch/i);
  });

  it('is a no-op when registry does not return the header', () => {
    // Old registries (pre-alpha.117) won't send X-Archive-Sha256.
    // The loader must not refuse downloads from those — the engineSha256
    // check at load is still load-bearing.
    const bytes = Buffer.from('any-bytes');
    expect(() => verifyArchiveSha(bytes, null)).not.toThrow();
  });

  it('refuses bytes flipped by a single byte (tamper detection)', () => {
    const original = Buffer.from('zveltio-test-package-bytes');
    const declared = createHash('sha256').update(original).digest('hex');
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0]! ^ 0x01; // flip one bit
    expect(() => verifyArchiveSha(tampered, declared)).toThrow(/mismatch/i);
  });
});
