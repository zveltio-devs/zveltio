/**
 * `zveltio extension sign` — an operator signs their own extension directory
 * (ADR 0056 d1: level 3, private). The engine loads it only when the key is on
 * its `OPERATOR_PUBLIC_KEYS_JSON` list, verifies it at every load, and runs it
 * on the extension runner, never inline.
 *
 * What is signed is the listing `@zveltio/sdk/publish/dir` builds, the function
 * the engine verifies with: every regular file but `signature.json` and a root
 * `node_modules/`, which never runs on the runner (the engine's
 * `ext-operator-signed` harness test signs with this CLI and loads the result).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _bytes, type ExtensionSignature, signBundle, verifyBundle } from '@zveltio/sdk/publish';
import { DIR_SIGNATURE_FILE, extensionDirListing } from '@zveltio/sdk/publish/dir';
import { readKeyFile, resolveKeyId } from './keys.js';

export { DIR_SIGNATURE_FILE };

/** The envelope written to `signature.json`: the archive envelope plus the tier it confers. */
export type DirSignature = ExtensionSignature & { tier: 'private' };

/** What an operator signs, built by the same function the engine verifies with. */
const operatorListing = (dir: string, name: string): Uint8Array =>
  extensionDirListing(dir, name, 'private', { operator: true });

function manifestName(dir: string): string {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`No manifest.json found at ${dir}`);
  const name = (JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }).name;
  if (typeof name !== 'string' || name === '') throw new Error('manifest.json has no "name"');
  return name;
}

export async function extensionSignCommand(opts: { dir?: string; keyId?: string }): Promise<void> {
  try {
    const dir = resolve(opts.dir ?? process.cwd());
    const name = manifestName(dir);
    const keypair = readKeyFile(resolveKeyId(opts.keyId));
    const envelope = await signBundle(operatorListing(dir, name), keypair);
    const signed: DirSignature = { ...envelope, tier: 'private' };
    writeFileSync(join(dir, DIR_SIGNATURE_FILE), `${JSON.stringify(signed, null, 2)}\n`);
    console.log(
      `✓ Signed "${name}" with key "${keypair.keyId}" → ${join(dir, DIR_SIGNATURE_FILE)}`,
    );
    console.log(
      '  The engine loads it at level 3 (private, on the extension runner) when its\n' +
        '  OPERATOR_PUBLIC_KEYS_JSON lists this key: `zveltio keys export ' +
        `${keypair.keyId}\` prints the entry. Sign again after any change.`,
    );
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }
}

/** Raw Ed25519 public key (hex) as the JWK `verifyBundle` takes. */
function hexToJwk(hex: string): JsonWebKey {
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));
  const x = _bytes.bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { kty: 'OKP', crv: 'Ed25519', x };
}

/**
 * The public key to check `keyId` against: the engine's operator list when this
 * shell has it (`OPERATOR_PUBLIC_KEYS_JSON`), else the operator's own key file.
 */
function operatorKey(keyId: string): { jwk: JsonWebKey; from: string } | null {
  const raw = process.env.OPERATOR_PUBLIC_KEYS_JSON;
  if (raw) {
    const list = JSON.parse(raw) as { keyId?: unknown; publicKeyHex?: unknown }[];
    const hit = list.find((k) => k.keyId === keyId && typeof k.publicKeyHex === 'string');
    return hit
      ? { jwk: hexToJwk(hit.publicKeyHex as string), from: 'OPERATOR_PUBLIC_KEYS_JSON' }
      : null;
  }
  try {
    return { jwk: readKeyFile(keyId).publicJwk, from: `~/.zveltio/keys/${keyId}.json` };
  } catch {
    return null;
  }
}

/** Verify `dir` as the engine will at load, under the name it will load as. Throws why not. */
export async function verifyExtensionDirSignature(dir: string, name: string): Promise<string> {
  const file = join(dir, DIR_SIGNATURE_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `${dir} is not signed. Sign it first: zveltio extension sign --dir ${dir} [--key-id <id>]`,
    );
  }
  const sig = JSON.parse(readFileSync(file, 'utf8')) as DirSignature;
  if (sig.tier !== 'private') {
    throw new Error(
      `${DIR_SIGNATURE_FILE} claims tier ${JSON.stringify(sig.tier)}; an operator key confers "private" only`,
    );
  }
  const key = operatorKey(sig.keyId);
  if (!key) {
    throw new Error(
      `signed with key "${sig.keyId}", which is neither in OPERATOR_PUBLIC_KEYS_JSON nor in ~/.zveltio/keys`,
    );
  }
  const r = await verifyBundle(operatorListing(dir, name), sig, key.jwk);
  if (!r.ok) {
    throw new Error(
      `the directory no longer matches what key "${sig.keyId}" signed (a file changed, was ` +
        `added or removed, or the name differs): ${r.reason}`,
    );
  }
  return `key "${sig.keyId}" (${key.from})`;
}
