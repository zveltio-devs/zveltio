import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  verifySignature,
  parseSignature,
  sha256Hex,
  SignatureInvalidError,
  type ExtensionSignature,
} from '../../lib/signature-verify.js';
import { getTrustedKeys, hexToBytes } from '../../lib/registry-keys.js';

// Helpers ─────────────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

/**
 * Generate an Ed25519 keypair, export the raw 32-byte public key, sign the
 * hex form of a sha256 (matching what the registry would produce), and
 * publish it under REGISTRY_PUBLIC_KEYS_JSON.
 */
async function setupKeyAndSign(archive: Uint8Array, keyId: string): Promise<{
  signature: ExtensionSignature;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
    { keyId, publicKeyHex: bytesToHex(rawPub) },
  ]);

  const bundleSha256 = await sha256Hex(archive);
  const dataBytes = new TextEncoder().encode(bundleSha256);
  const sigBuf = await crypto.subtle.sign(
    { name: 'Ed25519' },
    keyPair.privateKey,
    dataBytes as unknown as BufferSource,
  );

  return {
    signature: {
      algorithm: 'ed25519',
      signature: bytesToBase64(new Uint8Array(sigBuf)),
      bundleSha256,
      signedAt: new Date().toISOString(),
      keyId,
    },
  };
}

// Tests ───────────────────────────────────────────────────────────────────────

describe('signature-verify', () => {
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.REGISTRY_PUBLIC_KEYS_JSON;
    delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = envBackup;
  });

  it('verifies a valid signature against an archive', async () => {
    const archive = new TextEncoder().encode('hello world');
    const { signature } = await setupKeyAndSign(archive, 'test-key-1');
    await expect(verifySignature(archive, signature, 'my-ext')).resolves.toBeUndefined();
  });

  it('rejects a tampered archive (sha256 mismatch)', async () => {
    const archive = new TextEncoder().encode('hello world');
    const { signature } = await setupKeyAndSign(archive, 'test-key-2');

    const tampered = new TextEncoder().encode('hello world!'); // extra byte
    await expect(verifySignature(tampered, signature, 'my-ext'))
      .rejects.toBeInstanceOf(SignatureInvalidError);
    await expect(verifySignature(tampered, signature, 'my-ext'))
      .rejects.toThrow(/bundleSha256 mismatch/);
  });

  it('rejects an unknown keyId', async () => {
    const archive = new TextEncoder().encode('payload');
    const { signature } = await setupKeyAndSign(archive, 'test-key-3');

    // Drop the key registry so the signature's keyId no longer resolves.
    delete process.env.REGISTRY_PUBLIC_KEYS_JSON;

    await expect(verifySignature(archive, signature, 'my-ext'))
      .rejects.toThrow(/unknown keyId/);
  });

  it('rejects a signature signed by a different key', async () => {
    const archive = new TextEncoder().encode('shared payload');

    // Generate two keypairs but register only the FIRST. Use the SECOND to sign,
    // then claim it was the first.
    const keyA = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const keyB = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;

    const rawA = new Uint8Array(await crypto.subtle.exportKey('raw', keyA.publicKey));
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      { keyId: 'key-a', publicKeyHex: bytesToHex(rawA) },
    ]);

    const bundleSha256 = await sha256Hex(archive);
    const sigBuf = await crypto.subtle.sign(
      { name: 'Ed25519' },
      keyB.privateKey,
      new TextEncoder().encode(bundleSha256) as unknown as BufferSource,
    );

    const sig: ExtensionSignature = {
      algorithm: 'ed25519',
      signature: bytesToBase64(new Uint8Array(sigBuf)),
      bundleSha256,
      keyId: 'key-a', // lying about which key signed it
    };

    await expect(verifySignature(archive, sig, 'my-ext'))
      .rejects.toThrow(/Ed25519 verification failed/);
  });

  it('rejects malformed base64 signature', async () => {
    const archive = new TextEncoder().encode('x');
    const { signature } = await setupKeyAndSign(archive, 'key-bad-b64');
    const broken: ExtensionSignature = { ...signature, signature: '!!! not base64 !!!' };
    await expect(verifySignature(archive, broken, 'my-ext'))
      .rejects.toThrow();
  });

  it('rejects a signature with wrong byte length', async () => {
    const archive = new TextEncoder().encode('y');
    const { signature } = await setupKeyAndSign(archive, 'key-short');
    const short: ExtensionSignature = {
      ...signature,
      signature: bytesToBase64(new Uint8Array(16)),
    };
    await expect(verifySignature(archive, short, 'my-ext'))
      .rejects.toThrow(/is not 64 bytes/);
  });
});

describe('parseSignature', () => {
  it('accepts well-formed signature shapes', () => {
    const ok = {
      algorithm: 'ed25519',
      signature: 'abc',
      bundleSha256: 'def',
      keyId: 'k',
    };
    expect(parseSignature(ok, 'ext').keyId).toBe('k');
  });

  it('rejects wrong algorithm', () => {
    expect(() =>
      parseSignature(
        { algorithm: 'rsa', signature: 'a', bundleSha256: 'b', keyId: 'k' },
        'ext',
      ),
    ).toThrow(/missing required fields or has wrong algorithm/);
  });

  it('rejects missing fields', () => {
    expect(() =>
      parseSignature({ algorithm: 'ed25519', signature: 'a' }, 'ext'),
    ).toThrow();
  });

  it('rejects null / non-object input', () => {
    expect(() => parseSignature(null, 'ext')).toThrow();
    expect(() => parseSignature('string', 'ext')).toThrow();
    expect(() => parseSignature(42, 'ext')).toThrow();
  });
});

describe('registry-keys env loading', () => {
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.REGISTRY_PUBLIC_KEYS_JSON;
    delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = envBackup;
  });

  it('returns empty when env is unset', () => {
    expect(getTrustedKeys()).toEqual([]);
  });

  it('parses valid env entries', () => {
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      { keyId: 'k1', publicKeyHex: 'aa'.repeat(32) },
    ]);
    const keys = getTrustedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].keyId).toBe('k1');
    expect(keys[0].publicKey.length).toBe(32);
  });

  it('skips entries with wrong length', () => {
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      { keyId: 'short', publicKeyHex: 'aabb' },
    ]);
    expect(getTrustedKeys()).toEqual([]);
  });

  it('skips entries missing required fields', () => {
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      { publicKeyHex: 'aa'.repeat(32) },
      { keyId: 'k2' },
    ]);
    expect(getTrustedKeys()).toEqual([]);
  });

  it('returns empty array on non-JSON input', () => {
    process.env.REGISTRY_PUBLIC_KEYS_JSON = 'not-valid-json{';
    expect(getTrustedKeys()).toEqual([]);
  });

  it('hexToBytes round-trips', () => {
    const input = 'deadbeef';
    const bytes = hexToBytes(input);
    expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('hexToBytes rejects odd length', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });
});
