/**
 * The listing of an extension directory, the one place both sides build it:
 * `zveltio extension sign` signs it, the engine verifies it at every load and
 * compares a download with the archive the registry signed. Two copies drifted
 * apart would refuse every signed directory, so there is one (ADR 0056 d1).
 *
 *     zveltio-extension-dir/1
 *     name <the name the engine loads it as>
 *     tier <tier>
 *     <sha256 hex> <path relative to the root, "/"-separated>   (one per file, sorted)
 *
 * Node only (`node:fs`), unlike `@zveltio/sdk/publish`.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
