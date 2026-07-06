/**
 * Trusted Ed25519 public keys for verifying extension archives downloaded
 * from the marketplace registry. See `signature-verify.ts` for the actual
 * verification logic.
 *
 * Two sources combine:
 *
 *   1. `BUILTIN_KEYS` — hardcoded into the engine binary at build time.
 *      Production builds ship with the registry's current pubkey; rotating
 *      the registry key requires shipping a new engine release (acceptable
 *      because key rotation is a deliberate, rare event).
 *
 *   2. `REGISTRY_PUBLIC_KEYS_JSON` env var — a JSON-encoded array of
 *      `{ keyId, publicKeyHex }` entries. Lets self-hosted operators trust
 *      additional registries (private marketplaces, internal mirrors) without
 *      rebuilding the binary.
 *
 * Today's `BUILTIN_KEYS` is empty: signing is opt-in via the
 * `REQUIRE_EXTENSION_SIGNATURES` env var. Once the registry starts producing
 * signature.json files, the registry's pubkey will land here and the env
 * flag will default to true.
 */

export interface RegistryKey {
  /** Stable identifier so signatures can reference which key signed them. */
  keyId: string;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

const BUILTIN_KEYS: RegistryKey[] = [
  // Production zveltio-registry signing key (wave 36, 2026-05-17). Compiled
  // binaries trust archives signed by this key without any env-var setup.
  // Operators can layer additional trusted keys via
  // REGISTRY_PUBLIC_KEYS_JSON for private mirrors.
  {
    keyId: 'registry-prod-2026',
    publicKey: hexToBytes('7c9182ab9015d40f9199b7e282357e3ea21d6697c2c51a7c43ca9dfc9a7fc123'),
  },
];

interface EnvKeyEntry {
  keyId?: unknown;
  publicKeyHex?: unknown;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex string (odd length): ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) {
      throw new Error(`invalid hex byte at offset ${i * 2}`);
    }
    out[i] = b;
  }
  return out;
}

function loadEnvKeys(): RegistryKey[] {
  const raw = process.env.REGISTRY_PUBLIC_KEYS_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[registry-keys] REGISTRY_PUBLIC_KEYS_JSON is not valid JSON: ${(err as Error).message}`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[registry-keys] REGISTRY_PUBLIC_KEYS_JSON must be a JSON array');
    return [];
  }
  const out: RegistryKey[] = [];
  for (const entry of parsed as EnvKeyEntry[]) {
    if (typeof entry?.keyId !== 'string' || typeof entry?.publicKeyHex !== 'string') {
      console.warn('[registry-keys] skipping entry missing keyId or publicKeyHex');
      continue;
    }
    try {
      const publicKey = hexToBytes(entry.publicKeyHex);
      if (publicKey.length !== 32) {
        console.warn(
          `[registry-keys] key ${entry.keyId}: expected 32-byte Ed25519 pubkey, got ${publicKey.length}`,
        );
        continue;
      }
      out.push({ keyId: entry.keyId, publicKey });
    } catch (err) {
      console.warn(`[registry-keys] key ${entry.keyId} rejected: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Combined list of trusted keys, recomputed each call so env changes are picked up in dev. */
export function getTrustedKeys(): RegistryKey[] {
  return [...BUILTIN_KEYS, ...loadEnvKeys()];
}

export function findKeyById(keyId: string): RegistryKey | null {
  return getTrustedKeys().find((k) => k.keyId === keyId) ?? null;
}

/** Exported for tests that need to construct keys from hex. */
export { hexToBytes };
