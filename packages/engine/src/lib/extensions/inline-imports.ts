// What an inline extension's code may load, held at the moment it loads.
//
// `verifyRegistrySignedDir` proves the directory is the archive the registry
// signed, and `importOutsideDir` reads its imports, before the `import()`; a
// file changed after either is what would run (DR-TASKS l.58). So every module
// Bun loads from a guarded directory is read once here, hashed against the
// sha256 its signature lists, scanned, and handed to Bun as those exact bytes —
// the inline counterpart of the worker's `verifiedBundle` (ADR 0056 d1). A file
// the signature does not list (a nested extension's, `.zveltio-registry/`) is
// refused, the entry included.
//
// A computed `require(x)` is resolved by the code at run time, past any scan:
// `Module._resolveFilename` is the one hook Bun calls for every `require` and
// `import.meta.require`, bare specifiers included, with the requiring module
// (measured, Bun 1.4.4: `Bun.plugin` `onResolve` is never called for a bare
// specifier, and `module.register` hooks are never called). A computed
// `import(x)` reaches no hook at all and is refused by the scan
// (`fileImportsOutside`).

import { readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { extname, isAbsolute, relative, sep } from 'node:path';
import { fileImportsOutside, isUnder } from './extension-paths.js';

const LOADERS: Record<string, 'js' | 'ts' | 'jsx' | 'tsx' | 'json'> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.jsx': 'jsx',
  '.tsx': 'tsx',
  '.json': 'json',
};

/**
 * Real directory → each signed file's sha256 by its posix path in it; null once
 * a later inline load of it was no registry-signed bundle (the test override, a
 * development `.ts` source), which production refuses before any import.
 */
const guarded = new Map<string, ReadonlyMap<string, string> | null>();

// Called for every `require` in the process once a directory is guarded: a
// prefix test per directory, no path arithmetic (Bun hands it normalized real paths).
function guardedDir(path: string | undefined): string | undefined {
  if (!path) return undefined;
  for (const [dir, files] of guarded) if (files && path.startsWith(dir + sep)) return dir;
  return undefined;
}

function serve(dir: string, path: string): { contents: string; loader: string } {
  const rel = relative(dir, path).split(sep).join('/');
  const loader = LOADERS[extname(path)];
  const files = guarded.get(dir);
  // Released: loaded as Bun would (its plugin cannot be unregistered).
  if (files === null && loader) return { contents: readFileSync(path, 'utf8'), loader };
  const signed = files?.get(rel);
  if (!signed) {
    throw new Error(
      `${rel} is not a file the extension's registry signature covers, so it does not load ` +
        `in the engine process`,
    );
  }
  if (!loader) throw new Error(`${rel} is not JavaScript, TypeScript or JSON: not loaded inline`);
  const bytes = readFileSync(path);
  if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== signed) {
    throw new Error(
      `${rel} changed after the extension's registry signature was verified; load it again`,
    );
  }
  const contents = bytes.toString('utf8');
  const why = fileImportsOutside(dir, path, contents);
  if (why !== null) throw new Error(`refused: ${why}`);
  return { contents, loader };
}

let resolveHooked = false;

function hookRequire(): void {
  if (resolveHooked) return;
  resolveHooked = true;
  const Module = require('node:module') as {
    _resolveFilename: (
      request: string,
      parent?: { filename?: string },
      ...rest: unknown[]
    ) => string;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const dir = guardedDir(parent?.filename);
    if (dir === undefined || isBuiltin(request)) {
      return resolveFilename.call(this, request, parent, ...rest);
    }
    const isPath =
      request.startsWith('./') ||
      request.startsWith('../') ||
      request.startsWith('file:') ||
      isAbsolute(request);
    const resolved = isPath ? resolveFilename.call(this, request, parent, ...rest) : null;
    if (resolved === null || !isUnder(dir, resolved)) {
      throw new Error(
        `${relative(dir, parent?.filename ?? dir)} requires "${request}", outside the ` +
          `extension's directory, which is all its registry signature covers`,
      );
    }
    return resolved;
  };
}

/**
 * From now on every module Bun loads from `extDir` must be a file `files` (the
 * verified registry signature's) lists, with those bytes, and nothing it
 * requires may resolve outside `extDir`. Called again with a later signature,
 * it holds the directory to that one; with null, to none.
 */
export function guardInlineImports(
  extDir: string,
  files: ReadonlyMap<string, string> | null,
): void {
  const dir = realpathSync(extDir);
  const known = guarded.has(dir);
  if (files === null) {
    if (known) guarded.set(dir, null);
    return;
  }
  guarded.set(dir, files);
  hookRequire();
  if (known) return;
  // One filter per directory, so a module of the engine's own never reaches this callback.
  const filter = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`);
  Bun.plugin({
    name: `zveltio-inline:${dir}`,
    setup(build) {
      build.onLoad({ filter }, ({ path }) => serve(dir, path) as never);
    },
  });
}
