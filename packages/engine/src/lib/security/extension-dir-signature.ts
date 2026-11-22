/**
 * An extension directory signed by its operator (ADR 0056 d1, RFC v3 phase A).
 *
 * `signature.json` at the extension's root is the `ExtensionSignature` envelope
 * `zveltio extension sign` writes, plus the tier it confers. What it signs is
 * the sha256 of this listing, built from the directory as it is at load:
 *
 *     zveltio-extension-dir/1
 *     name <the name the engine loads it as>
 *     tier private
 *     <sha256 hex> <path relative to the root, "/"-separated>   (one per file, sorted)
 *
 * Every regular file is listed but `signature.json` itself and a root
 * `node_modules/` (never run on the runner: `OPERATOR_UNLISTED`), so a byte
 * changed, a file added or removed, the tier rewritten or the directory renamed
 * after signing changes the digest. A symbolic link is refused: what it points
 * to is outside what was signed. The CLI builds the same listing
 * (`packages/cli/src/commands/extension-sign.ts`); the two are held together by
 * `tests/harness/ext-operator-signed.test.ts`, which signs with the CLI and
 * loads here. The engine keeps its own copy: it runs from source and as a
 * binary without a built SDK, so it imports no SDK code at run time.
 *
 * Verified at every load, against the operator's key list only: a key there
 * confers level 3 and never more. An unknown key is a refusal, not a fallback.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findOperatorKeyById } from './registry-keys.js';
import { parseSignature, SignatureInvalidError, verifySignature } from './signature-verify.js';

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

/**
 * Where a download keeps the archive the registry signed and its signature
 * (`archive`, `archive.sig`), inside the extension's directory: what lets it run
 * inline, re-verified at every load (`verifyRegistrySignedDir`, U3).
 */
export const REGISTRY_SIGNED_DIR = '.zveltio-registry';

/**
 * The operator key that signed `extDir` and the sha256 of each file it signed
 * (by "/"-separated relative path), or null when it carries no signature.
 *
 * @throws SignatureInvalidError when a signature is there and does not hold:
 *         unknown key, a tier an operator key cannot confer, or content changed.
 */
export async function verifyExtensionDir(
  extName: string,
  extDir: string,
): Promise<{ keyId: string; files: ReadonlyMap<string, string> } | null> {
  const file = join(extDir, DIR_SIGNATURE_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SignatureInvalidError(
      extName,
      `${DIR_SIGNATURE_FILE} is not JSON: ${(err as Error).message}`,
    );
  }
  const sig = parseSignature(raw, extName);
  const tier = (raw as { tier?: unknown }).tier;
  if (tier !== 'private') {
    throw new SignatureInvalidError(
      extName,
      `${DIR_SIGNATURE_FILE} claims tier ${JSON.stringify(tier)}; an operator key confers ` +
        `level 3 ("private") only, never first-party or certified (ADR 0056)`,
    );
  }
  const key = findOperatorKeyById(sig.keyId);
  if (!key) {
    throw new SignatureInvalidError(
      extName,
      `signed with key "${sig.keyId}", which is not on this engine's operator key list ` +
        `(OPERATOR_PUBLIC_KEYS_JSON) — refused, not loaded unsigned`,
    );
  }
  let listing: Uint8Array;
  const files = new Map<string, string>();
  try {
    listing = extensionDirListing(extDir, extName, tier, { files, operator: true });
  } catch (err) {
    throw new SignatureInvalidError(extName, (err as Error).message);
  }
  try {
    await verifySignature(listing, sig, extName, key);
  } catch (err) {
    const detail = err instanceof SignatureInvalidError ? err.detail : (err as Error).message;
    throw new SignatureInvalidError(
      extName,
      `the directory no longer matches what key "${sig.keyId}" signed (a file changed, ` +
        `was added or removed, or it was renamed): ${detail}`,
    );
  }
  return { keyId: sig.keyId, files };
}
