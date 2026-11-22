/**
 * `zveltio extension sign` — an operator signs their own extension directory
 * (ADR 0056 d1: level 3, private). The engine loads it only when the key is on
 * its `OPERATOR_PUBLIC_KEYS_JSON` list, verifies it at every load, and runs it
 * on the extension runner, never inline.
 *
 * What is signed is the listing below, byte for byte the engine's
 * (`packages/engine/src/lib/security/extension-dir-signature.ts`): every regular file but `signature.json` and a root
 * `node_modules/`, which never runs on the runner (the engine's
 * `ext-operator-signed` harness test signs with this CLI and loads the result).
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _bytes, type ExtensionSignature, signBundle, verifyBundle } from '@zveltio/sdk/publish';
import { readKeyFile, resolveKeyId } from './keys.js';

export const DIR_SIGNATURE_FILE = 'signature.json';

/**
 * Left out of an operator's listing, at the root only: `bun install` puts the
 * dependency tree and its `.bin` links there. Nothing of it runs on the
 * extension runner, where an operator-signed extension always runs: the worker
 * imports only the signed bundle's bytes, from a blob URL, in a process whose
 * working directory is `/`, so no specifier resolves from this directory. Not
 * left out of a download's listing: a registry-signed extension may run inline,
 * where a bare specifier in its bundle would resolve from it.
 */
export const OPERATOR_UNLISTED = 'node_modules';

export interface DirListingOptions {
  /** Receives each listed path's sha256. */
  files?: Map<string, string>;
  /** The listing an operator signature covers: `OPERATOR_UNLISTED` left out. */
  operator?: boolean;
}

/**
 * Every regular file but `signature.json`, so a byte changed, a file added or
 * removed, the tier rewritten or the directory renamed changes the listing.
 * Throws on a symbolic link (what it points to is outside what was signed) or
 * a name a line cannot hold.
 */
export function extensionDirListing(
  dir: string,
  name: string,
  tier: string,
  { files, operator = false }: DirListingOptions = {},
): Uint8Array {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${entry}` : entry;
      if (path === DIR_SIGNATURE_FILE || (operator && path === OPERATOR_UNLISTED)) continue;
      if (/[\r\n]/.test(path))
        throw new Error(`file name ${JSON.stringify(path)} cannot be listed`);
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        const hash = createHash('sha256')
          .update(readFileSync(join(dir, path)))
          .digest('hex');
        files?.set(path, hash);
        lines.push(`${hash} ${path}`);
      } else
        throw new Error(`"${path}" is not a regular file or directory (a link is never signed)`);
    }
  };
  walk('');
  lines.sort();
  return new TextEncoder().encode(
    `zveltio-extension-dir/1\nname ${name}\ntier ${tier}\n${lines.map((l) => `${l}\n`).join('')}`,
  );
}

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
