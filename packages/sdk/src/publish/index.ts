/**
 * Publish primitives for `zveltio extension publish` (S4-05).
 *
 * Pure functions: WebCrypto Ed25519 keypairs, archive hashing, signature
 * envelope shape that matches the engine's verifier (S1-01). No filesystem,
 * no HTTP — the CLI layers those on top.
 *
 * Storage format: JWK. We pick JWK over PKCS#8 because it is JSON-native
 * (one file per key, plain `Bun.write`), works in Cloudflare Workers without
 * conversion, and survives copy-paste through environment variables.
 *
 * Signature shape mirrors `ExtensionSignature` in
 * `packages/engine/src/lib/signature-verify.ts` so the engine can verify
 * archives produced here without translation.
 */

/** Stored keypair format. Matches WebCrypto JWK + a Zveltio-specific keyId. */
export interface ZveltioKeypair {
  /** Stable identifier; default is a short random hex string. */
  keyId: string;
  /** Created-at, RFC 3339. Informational. */
  createdAt: string;
  /** Public half — safe to share. */
  publicJwk: JsonWebKey;
  /** Private half — keep on disk + permission 600. */
  privateJwk: JsonWebKey;
}

/** Signature envelope written next to `<archive>.zvext` as `<archive>.zvext.sig`. */
export interface ExtensionSignature {
  algorithm: 'ed25519';
  /** Base64 of the 64-byte Ed25519 signature. */
  signature: string;
  /** Hex of sha256(archive bytes). */
  bundleSha256: string;
  /** RFC 3339, informational. */
  signedAt: string;
  /** Key identifier — engine looks this up in its trusted keys list. */
  keyId: string;
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa is available in Bun + browsers. Node 22+ has it too.
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compute sha256(bytes) → lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return bytesToHex(buf);
}

/**
 * Generate a fresh Ed25519 keypair.
 *
 * @param keyId  Optional stable identifier. If omitted, generates a short
 *               random hex string. Useful to keep human-readable
 *               ("zveltio-prod-2026") or to scope per-publisher.
 */
export async function generateKeypair(keyId?: string): Promise<ZveltioKeypair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const kp = pair as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const finalKeyId = keyId ?? randomKeyId();
  return {
    keyId: finalKeyId,
    createdAt: new Date().toISOString(),
    publicJwk,
    privateJwk,
  };
}

function randomKeyId(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return 'zv-' + bytesToHex(buf);
}

/** Import a private JWK back into a CryptoKey usable for signing. */
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
}

/** Import a public JWK back into a CryptoKey usable for verification. */
export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
}

/**
 * Build the signature envelope for a given archive.
 *
 * Signs over the UTF-8 bytes of the lowercase hex sha256 — same shape the
 * engine verifier (`verifySignature`) expects. Stays away from signing the
 * raw archive directly so the signature payload is a fixed 64 bytes
 * regardless of archive size.
 */
export async function signBundle(
  archive: Uint8Array,
  keypair: ZveltioKeypair,
): Promise<ExtensionSignature> {
  const bundleSha256 = await sha256Hex(archive);
  const key = await importPrivateKey(keypair.privateJwk);
  const dataBytes = new TextEncoder().encode(bundleSha256.toLowerCase());
  const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, key, dataBytes as any);
  return {
    algorithm: 'ed25519',
    signature: bytesToBase64(new Uint8Array(sigBuf)),
    bundleSha256,
    signedAt: new Date().toISOString(),
    keyId: keypair.keyId,
  };
}

/**
 * Verify a signature against an archive — symmetric to the engine's
 * `verifySignature`. Returned errors are plain strings so the CLI can
 * print them without leaking internal types.
 */
export async function verifyBundle(
  archive: Uint8Array,
  signature: ExtensionSignature,
  publicJwk: JsonWebKey,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signature.algorithm !== 'ed25519') {
    return { ok: false, reason: `unsupported algorithm "${signature.algorithm}"` };
  }
  const actualHash = await sha256Hex(archive);
  if (actualHash.toLowerCase() !== signature.bundleSha256.toLowerCase()) {
    return { ok: false, reason: `bundleSha256 mismatch (expected ${signature.bundleSha256}, got ${actualHash})` };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signature.signature);
  } catch (err) {
    return { ok: false, reason: `signature is not valid base64: ${(err as Error).message}` };
  }
  if (sigBytes.length !== 64) {
    return { ok: false, reason: `signature length ${sigBytes.length} is not 64 bytes` };
  }
  const key = await importPublicKey(publicJwk);
  const dataBytes = new TextEncoder().encode(signature.bundleSha256.toLowerCase());
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes as any, dataBytes as any);
  return ok ? { ok: true } : { ok: false, reason: 'Ed25519 verification failed' };
}

/**
 * Convenience: derive a registry-style "trusted key" entry from a public
 * JWK so a publisher can copy-paste it into the engine's
 * `REGISTRY_PUBLIC_KEYS_JSON` env (or hand it to the registry admin).
 *
 * Returns `{ keyId, publicKeyHex }` — exact shape the engine's
 * `registry-keys.ts` parser expects.
 */
export async function exportTrustedKeyEntry(
  keyId: string,
  publicJwk: JsonWebKey,
): Promise<{ keyId: string; publicKeyHex: string }> {
  // Re-import as `extractable: true` — the cached `importPublicKey` produces
  // a non-extractable key for hot-path verification. Cheap (microseconds) and
  // keeps the exporter as a one-liner for callers.
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, true, ['verify']);
  const rawBuf = await crypto.subtle.exportKey('raw', key);
  return { keyId, publicKeyHex: bytesToHex(new Uint8Array(rawBuf)) };
}

// Re-exports for the CLI to encode/decode bytes without pulling in node:buffer.
export const _bytes = { bytesToHex, bytesToBase64, base64ToBytes };
