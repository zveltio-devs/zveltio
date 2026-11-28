// Extension base-directory resolution + on-disk presence checks.
//
// Extracted from extension-loader.ts (loader split). Pure filesystem helpers
// with their own short-TTL presence cache; no loader state.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';

/**
 * The file a manifest field names (`studio.pages[].schema`, `engine.entry`, …),
 * under `<extDir>/<base>`. Throws when the name could reach outside the
 * extension's directory — absolute, or with a `..` segment — because a
 * signature covers only the files under that directory (DR-TASKS l.58): a
 * signed manifest must not point the engine at a file nobody signed.
 */
export function manifestFile(extDir: string, base: string, rel: unknown): string {
  if (
    typeof rel !== 'string' ||
    rel === '' ||
    rel.includes('\0') ||
    isAbsolute(rel) ||
    rel.split(/[\\/]/).includes('..')
  ) {
    throw new Error(
      `manifest path ${JSON.stringify(rel)} is outside the extension's directory ` +
        `(absolute, or a ".." segment); only files under it are signed`,
    );
  }
  return join(extDir, base, rel);
}

const LOADERS: Record<string, 'js' | 'jsx' | 'ts' | 'tsx'> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
};

// A dynamic `import(` — syntax, so no alias reaches it — after anything but a
// member access (`a.import(`; `...import(` is a spread, not one). Comments may
// sit between the keyword and its parenthesis.
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`;
const DYNAMIC_IMPORT = new RegExp(String.raw`(?<![\w$]|(?<!\.)\.\s*)import${GAP}\(`, 'g');
const LITERAL_ARG = new RegExp(
  String.raw`^${GAP}(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')${GAP}[),]`,
);

/**
 * Why `file` cannot be imported in the engine process, given its `source`, or
 * null when it can; `next` receives each file under `extDir` it imports. Its
 * literal imports must name runtime builtins (`node:*`, `bun:*`, a bare `fs`)
 * or files under `extDir`, which is what a signature covers (DR-TASKS l.57). A
 * bare specifier resolves from the first `node_modules` up the tree —
 * `<EXTENSIONS_DIR>/node_modules`, where the engine installs core packages and
 * peers, or any ancestor's — and none is signed; a bundled entry inlines its
 * dependencies (`zveltio extension pack`). A relative or absolute path out of
 * `extDir` reaches the same files.
 *
 * A computed `import(x)` is refused outright: Bun asks no runtime hook where a
 * bare one resolves (measured, Bun 1.4.4), so nothing could hold it to these
 * rules. A computed `require(x)` is held at run time (`inline-imports.ts`).
 */
export function fileImportsOutside(
  extDir: string,
  file: string,
  source: string,
  next: (target: string) => void = () => {},
): string | null {
  const loader = LOADERS[extname(file)];
  if (!loader) return null; // JSON, text: imports nothing
  const where = relative(extDir, file);
  for (const m of source.matchAll(DYNAMIC_IMPORT)) {
    const at = m.index + m[0].length;
    if (!LITERAL_ARG.test(source.slice(at, at + 4096))) {
      return (
        `${where} has a computed import() (${JSON.stringify(source.slice(m.index, at + 30))}): ` +
        `where it resolves cannot be held to the files its signature covers; import a literal path`
      );
    }
  }
  // `Bun.resolveSync` answers the real path: a symlink on the way to `extDir` is not a way out.
  const roots = [extDir, realpathSync(extDir)];
  const inside = (p: string) => roots.some((root) => isUnder(root, p));
  let imports: ReturnType<Bun.Transpiler['scanImports']>;
  try {
    imports = new Bun.Transpiler({ loader }).scanImports(source);
  } catch (err) {
    return `${where} cannot be read for its imports: ${(err as Error).message}`;
  }
  for (const { path: spec } of imports) {
    if (isBuiltin(spec)) continue;
    const isPath = spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec);
    if (!isPath && !spec.startsWith('file:')) {
      return (
        `${where} imports "${spec}", which resolves from a node_modules outside the ` +
        `extension's directory, and nothing there is signed; bundle it in ` +
        `(\`zveltio extension pack\`)`
      );
    }
    const refuse = `${where} imports "${spec}", outside the extension's directory, which is all a signature covers`;
    let target: string;
    try {
      const path = spec.replace(/[?#].*$/, ''); // the runtime drops a query too
      target = isPath ? resolve(dirname(file), path) : fileURLToPath(path);
    } catch {
      return refuse;
    }
    if (!inside(target)) return refuse;
    try {
      target = Bun.resolveSync(target, dirname(file));
    } catch {
      continue; // unresolvable: the import itself fails, before any of it runs
    }
    if (!inside(target)) return refuse;
    next(target);
  }
  return null;
}

/** `p` is strictly under `root`. */
export function isUnder(root: string, p: string): boolean {
  const r = relative(root, p);
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

/**
 * Why `entry` cannot be imported in the engine process, or null when it can:
 * `fileImportsOutside` for it and every file it imports in turn, read from disk.
 */
export function importOutsideDir(extDir: string, entry: string): string | null {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!LOADERS[extname(file)]) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (err) {
      return `${relative(extDir, file)} cannot be read for its imports: ${(err as Error).message}`;
    }
    const why = fileImportsOutside(extDir, file, source, (t) => queue.push(t));
    if (why !== null) return why;
  }
  return null;
}

/**
 * Resolve where extension files live.  Checked in priority order:
 *  1. EXTENSIONS_DIR env var (explicit config — always wins)
 *  2. ./extensions/ relative to the process CWD (Docker / production binary)
 *  3. Sibling zveltio-extensions repo (monorepo dev: ../../../../../zveltio-extensions)
 *  4. ./extensions/ as creation target even if it doesn't exist yet
 */
export function resolveExtensionsBase(): string {
  const own = installExtensionsBase();
  if (own) return own;
  const cwdPath = join(process.cwd(), 'extensions');
  // Dev: zveltio-extensions is a sibling of the main monorepo repo.
  // packages/engine/src/lib → 4 levels up → monorepo root → 1 more up → ecosystem root.
  const devPath = join(import.meta.dir, '../../../../../zveltio-extensions');
  if (existsSync(devPath)) return devPath;
  return cwdPath; // default target for first download
}

/**
 * The install's own extensions directory: EXTENSIONS_DIR, else `./extensions`
 * when it exists. Never the dev fallback to a sibling checkout — what an
 * install ships, not what a developer happens to have beside the repo.
 */
export function installExtensionsBase(): string | null {
  if (process.env.EXTENSIONS_DIR) return process.env.EXTENSIONS_DIR;
  const cwdPath = join(process.cwd(), 'extensions');
  return existsSync(cwdPath) ? cwdPath : null;
}

/**
 * Are an extension's files present on disk (i.e. nothing left to download)?
 *
 * An extension is "present" when it has an engine entry point
 * (`engine/index.{ts,js}` or the manifest's `engine.routes`) OR when it is a
 * UI-only extension (`contributes.engine === false`) whose `manifest.json` is on
 * disk. UI-only extensions (e.g. `developer/views`, `content/pdf-viewer`) ship no
 * engine by design — the load path registers them from manifest + Studio assets
 * alone (see loadExtension, the `contributes.engine === false` early-return).
 * Without the UI-only branch the install/enable handlers wrongly treat them as
 * "no files found / registry unreachable" even after a successful download.
 */
export function extensionFilesPresent(extDir: string): boolean {
  if (existsSync(join(extDir, 'engine/index.ts')) || existsSync(join(extDir, 'engine/index.js')))
    return true;
  const manifestPath = join(extDir, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Alternate engine entry declared in the manifest (manifest.engine.routes).
    if (m?.engine?.routes) {
      const alt = manifestFile(extDir, '', m.engine.routes);
      if (existsSync(alt)) return true;
    }
    // UI-only: manifest present + no engine contributed → nothing to download.
    if (m?.contributes?.engine === false) return true;
  } catch {
    /* malformed manifest — treat as not present so the caller surfaces it */
  }
  return false;
}

// Short-TTL cache for the marketplace LISTING only. GET /api/marketplace calls
// extensionFilesPresent once per catalog entry (54+ sync existsSync/readFileSync)
// on every admin poll. Disk state only changes on install/uninstall, so a few
// seconds of staleness is fine — and those handlers call invalidateFilesPresent
// for immediate accuracy. Install/enable themselves use the UNCACHED function so
// a just-finished download is seen right away.
const FILES_PRESENT_TTL_MS = 5000;
const filesPresentCache = new Map<string, { present: boolean; exp: number }>();

export function extensionFilesPresentCached(extDir: string): boolean {
  const hit = filesPresentCache.get(extDir);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.present;
  const present = extensionFilesPresent(extDir);
  filesPresentCache.set(extDir, { present, exp: now + FILES_PRESENT_TTL_MS });
  return present;
}

export function invalidateFilesPresent(extDir?: string): void {
  if (extDir) filesPresentCache.delete(extDir);
  else filesPresentCache.clear();
}
