/**
 * Ed25519 signature verification for extension archives (S1-01).
 *
 * Flow:
 *   1. Registry signs `bundleSha256` (hex of sha256(archive)) with its
 *      Ed25519 private key. Result published as `<archive_url>.sig` — a
 *      sibling JSON file with the shape of `ExtensionSignature`.
 *   2. Engine downloads the archive, then attempts to fetch the sibling
 *      signature file.
 *   3. If `REQUIRE_EXTENSION_SIGNATURES=true` and no signature is found,
 *      install fails with `SignatureMissingError`.
 *   4. If a signature is found, the engine verifies:
 *        a. sha256(archive) matches `bundleSha256`,
 *        b. Ed25519(publicKey, signature, bundleSha256) is valid,
 *        c. the `keyId` resolves to a trusted public key.
 *      Any failure throws `SignatureInvalidError`.
 *
 * The pubkey list is in `registry-keys.ts`; today it's empty + env-overridable.
 */

import { findKeyById, type RegistryKey } from './registry-keys.js';

/** Shape of the `<archive>.sig` JSON file published by the registry. */
export interface ExtensionSignature {
  algorithm: 'ed25519';
  /** Base64-encoded 64-byte Ed25519 signature. */
  signature: string;
  /** Hex-encoded sha256 of the archive bytes the signature attests to. */
  bundleSha256: string;
  /** RFC 3339 timestamp; informational. */
  signedAt?: string;
  /** Identifier of the public key the signature was produced with. */
  keyId: string;
}

export class SignatureMissingError extends Error {
  constructor(public readonly extensionName: string) {
    super(
      `Extension "${extensionName}" has no signature.json sibling. ` +
        `Either install signatures on the registry side, or set ` +
        `REQUIRE_EXTENSION_SIGNATURES=false to allow unsigned installs.`,
    );
    this.name = 'SignatureMissingError';
  }
}

export class SignatureInvalidError extends Error {
  constructor(
    public readonly extensionName: string,
    public readonly detail: string,
  ) {
    super(`Extension "${extensionName}" signature invalid: ${detail}`);
    this.name = 'SignatureInvalidError';
  }
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  // Bun + Node both have global atob; tolerate URL-safe encoding too.
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Lightweight runtime check so a typo in signature.json fails loud. */
function isValidSignatureShape(sig: unknown): sig is ExtensionSignature {
  if (!sig || typeof sig !== 'object') return false;
  const s = sig as Record<string, unknown>;
  return (
    s.algorithm === 'ed25519' &&
    typeof s.signature === 'string' &&
    typeof s.bundleSha256 === 'string' &&
    typeof s.keyId === 'string'
  );
}

export function parseSignature(input: unknown, extensionName: string): ExtensionSignature {
  if (!isValidSignatureShape(input)) {
    throw new SignatureInvalidError(
      extensionName,
      'signature.json is missing required fields or has wrong algorithm',
    );
  }
  return input;
}

/**
 * Verify an Ed25519 signature against an archive's bytes.
 *
 * @throws SignatureInvalidError if anything is off (mismatched hash, unknown
 *         keyId, bad signature, malformed inputs).
 */
export async function verifySignature(
  archive: Uint8Array,
  signature: ExtensionSignature,
  extensionName: string,
): Promise<void> {
  // 1. Resolve key.
  const key: RegistryKey | null = findKeyById(signature.keyId);
  if (!key) {
    throw new SignatureInvalidError(
      extensionName,
      `unknown keyId "${signature.keyId}" — add the registry pubkey to the engine binary or REGISTRY_PUBLIC_KEYS_JSON`,
    );
  }

  // 2. Verify the archive bytes match what the signature attests to.
  const actualHashBuf = await crypto.subtle.digest('SHA-256', archive as unknown as BufferSource);
  const actualHashHex = bytesToHex(actualHashBuf);
  if (actualHashHex.toLowerCase() !== signature.bundleSha256.toLowerCase()) {
    throw new SignatureInvalidError(
      extensionName,
      `bundleSha256 mismatch (expected ${signature.bundleSha256}, got ${actualHashHex})`,
    );
  }

  // 3. Verify the Ed25519 signature over bundleSha256 (its hex form, UTF-8 encoded).
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signature.signature);
  } catch (err) {
    throw new SignatureInvalidError(
      extensionName,
      `signature is not valid base64: ${(err as Error).message}`,
    );
  }
  if (sigBytes.length !== 64) {
    throw new SignatureInvalidError(
      extensionName,
      `signature length ${sigBytes.length} is not 64 bytes — Ed25519 signatures must be exactly 64 bytes`,
    );
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      key.publicKey as any,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch (err) {
    throw new SignatureInvalidError(
      extensionName,
      `failed to import key "${key.keyId}": ${(err as Error).message}`,
    );
  }

  const dataBytes = new TextEncoder().encode(signature.bundleSha256.toLowerCase());
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    cryptoKey,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    sigBytes as any,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    dataBytes as any,
  );
  if (!ok) {
    throw new SignatureInvalidError(
      extensionName,
      'Ed25519 verification failed (signature does not match data + key)',
    );
  }
}

/** Convenience for callers that need a hex digest separately. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return bytesToHex(buf);
}
