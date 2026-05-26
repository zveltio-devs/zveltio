import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  generateKeypair,
  signBundle,
  verifyBundle,
  exportTrustedKeyEntry,
  sha256Hex,
  type ZveltioKeypair,
} from '@zveltio/sdk/publish';
import { verifySignature } from '../../lib/signature-verify.js';

/**
 * Tests for the S4-05 publish primitives in `@zveltio/sdk/publish`.
 *
 * Why this lives in the engine test suite (and not the SDK's):
 *   - We want a cross-package compatibility check: a signature produced by
 *     `@zveltio/sdk/publish#signBundle` must verify against the engine's
 *     own `verifySignature` (the one the marketplace install path uses).
 *   - The engine already has the `bun:test` runner wired with the
 *     REGISTRY_PUBLIC_KEYS_JSON env knob; mirroring that setup in the SDK
 *     would duplicate scaffolding for no extra coverage.
 */

describe('@zveltio/sdk/publish — keypair', () => {
  it('generateKeypair() produces a valid Ed25519 JWK pair', async () => {
    const kp = await generateKeypair();
    expect(kp.keyId).toMatch(/^zv-[0-9a-f]+$/);
    expect(kp.privateJwk.kty).toBe('OKP');
    expect((kp.privateJwk as any).crv).toBe('Ed25519');
    expect(kp.publicJwk.kty).toBe('OKP');
    expect((kp.publicJwk as any).crv).toBe('Ed25519');
    // Private key has the secret material `d`; public must not.
    expect((kp.privateJwk as any).d).toBeDefined();
    expect((kp.publicJwk as any).d).toBeUndefined();
  });

  it('generateKeypair(keyId) honors the caller-supplied identifier', async () => {
    const kp = await generateKeypair('zveltio-test');
    expect(kp.keyId).toBe('zveltio-test');
  });

  it('produces a fresh random id for repeated calls', async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe('@zveltio/sdk/publish — sign/verify roundtrip', () => {
  it('signBundle + verifyBundle round-trips happy path', async () => {
    const kp = await generateKeypair('roundtrip-1');
    const archive = new TextEncoder().encode('fake .zvext content');
    const sig = await signBundle(archive, kp);
    expect(sig.algorithm).toBe('ed25519');
    expect(sig.keyId).toBe('roundtrip-1');
    expect(sig.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    const result = await verifyBundle(archive, sig, kp.publicJwk);
    expect(result.ok).toBe(true);
  });

  it('rejects when the archive bytes change after signing', async () => {
    const kp = await generateKeypair();
    const archive = new TextEncoder().encode('original');
    const sig = await signBundle(archive, kp);
    const tampered = new TextEncoder().encode('tampered');
    const result = await verifyBundle(tampered, sig, kp.publicJwk);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bundleSha256 mismatch/);
  });

  it('rejects when a different keypair tries to verify the signature', async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const archive = new TextEncoder().encode('payload');
    const sig = await signBundle(archive, a);
    const result = await verifyBundle(archive, sig, b.publicJwk);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Ed25519 verification failed/);
  });

  it('rejects malformed signature payloads', async () => {
    const kp = await generateKeypair();
    const archive = new TextEncoder().encode('payload');
    const sig = await signBundle(archive, kp);
    // Replace with invalid base64.
    const broken = { ...sig, signature: '!!!not-base64!!!' };
    const result = await verifyBundle(archive, broken, kp.publicJwk);
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported algorithm', async () => {
    const kp = await generateKeypair();
    const archive = new TextEncoder().encode('payload');
    const sig = await signBundle(archive, kp);
    const broken = { ...sig, algorithm: 'rsa-pss' as any };
    const result = await verifyBundle(archive, broken, kp.publicJwk);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unsupported algorithm/);
  });
});

describe('@zveltio/sdk/publish — engine compatibility', () => {
  let kp: ZveltioKeypair;
  const originalEnv = process.env.REGISTRY_PUBLIC_KEYS_JSON;

  beforeEach(async () => {
    kp = await generateKeypair('engine-compat-key');
    const trusted = await exportTrustedKeyEntry(kp.keyId, kp.publicJwk);
    // Same JSON shape the engine's `registry-keys.ts` parses out of env.
    // Round-trip between SDK exporter and engine importer is the actual
    // contract this test enforces.
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([trusted]);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = originalEnv;
  });

  it('engine.verifySignature accepts a signature produced by sdk.signBundle', async () => {
    const archive = new TextEncoder().encode('a fake archive for engine verifier');
    const sig = await signBundle(archive, kp);
    // No throw → success. verifySignature is void return.
    await verifySignature(archive, sig, 'test-ext');
  });

  it('engine.verifySignature rejects a tampered archive', async () => {
    const archive = new TextEncoder().encode('original');
    const sig = await signBundle(archive, kp);
    const tampered = new TextEncoder().encode('tampered');
    let caught: Error | null = null;
    try {
      await verifySignature(tampered, sig, 'test-ext');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/bundleSha256 mismatch/);
  });

  it('engine.verifySignature rejects a signature with an unknown keyId', async () => {
    const archive = new TextEncoder().encode('payload');
    const sig = await signBundle(archive, kp);
    const renamed = { ...sig, keyId: 'totally-unknown-key' };
    let caught: Error | null = null;
    try {
      await verifySignature(archive, renamed, 'test-ext');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/unknown keyId/);
  });
});

describe('@zveltio/sdk/publish — sha256Hex', () => {
  it('matches a known sha256', async () => {
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const hex = await sha256Hex(new TextEncoder().encode('hello'));
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is stable for empty input', async () => {
    const hex = await sha256Hex(new Uint8Array(0));
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('@zveltio/sdk/publish — exportTrustedKeyEntry', () => {
  it('emits a 32-byte raw public key as hex (matches engine env shape)', async () => {
    const kp = await generateKeypair('export-test');
    const entry = await exportTrustedKeyEntry(kp.keyId, kp.publicJwk);
    expect(entry.keyId).toBe('export-test');
    // 32 bytes → 64 hex chars, lowercase.
    expect(entry.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
