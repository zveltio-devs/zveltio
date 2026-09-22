/**
 * `zveltio extension pack` — build a production-ready engine artifact
 * for a single extension (Phase 1 of EXTENSIONS-V2-PHASE1.md).
 *
 * Pipeline:
 *   1. Read manifest.json from the extension root.
 *   2. Compile `engine/index.ts` → `engine/index.js` via `Bun.build`
 *      (with a resolve plugin that avoids hono's .d.ts exports bug).
 *      By default core deps
 *      (hono / zod / kysely / @hono/zod-validator) are BUNDLED into
 *      the artifact; allow-listed peer deps stay external and are
 *      installed by the engine at enable time.
 *   3. Compute SHA-256 of engine/index.js and write a fresh manifest
 *      that includes the `engine` + `integrity.engineSha256` blocks
 *      (the archive hash is computed by `extension publish` later).
 *
 * Why: Bun compiled-binary dynamic import cannot resolve bare
 * specifiers like `kysely` from on-disk node_modules. Bundling those
 * deps into the extension is the only path that works at runtime in
 * the binary install.
 *
 * Usage:
 *   $ zveltio extension pack            # current dir
 *   $ zveltio extension pack --dir crm  # explicit dir
 *
 * Output:
 *   <ext>/engine/index.js
 *   <ext>/engine/index.js.map (when --sourcemap)
 *   manifest.json updated in place with engine + integrity blocks
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { bundleExtensionEngine, EXTENSION_BUNDLE_CORE_DEPS } from '../lib/extension-bundle.js';
import { resolvePackIsolation } from '../lib/pack-isolation.js';
import { resolvePublisherTier } from '../lib/publisher-tier.js';

// Historically this was a list of peer deps allowed to stay external —
// the engine would install them at enable time into a shared
// node_modules. That model never worked on the Bun compiled binary,
// so it was retired in alpha.113. Kept as a const-empty marker; the
// only valid configuration today is `engine.bundlePeers: true`.
const PEER_DEP_ALLOWLIST = new Set<string>();

/**
 * Remove the packing machine's filesystem layout from the bundle.
 *
 * Bun replaces `__dirname` in a CommonJS dependency with the absolute path it
 * resolved at build time, and leaves resolved paths in its module comments. A
 * packed extension therefore shipped lines like
 *
 *     var __dirname = "/home/someone/zveltio-extensions/node_modules/pdfkit/js";
 *
 * which published the packer's home directory to every installation, and — for
 * any dependency that actually reads from `__dirname` — pointed at a directory
 * the installation does not have. An extension ships as one bundled file, so
 * nothing under `node_modules` travels with it and no such path can ever
 * resolve on the target.
 *
 * Rewriting it does not change behaviour: a lookup that was going to fail still
 * fails, and now fails the same way everywhere instead of succeeding only on the
 * machine that packed it. What it removes is the leak, and the false green that
 * comes with a path which happens to exist locally.
 *
 * The tail is kept (`node_modules/pdfkit/js`) so a stack trace still names the
 * package it came from.
 *
 * Returns the number of rewrites, so `pack` can report it rather than do this
 * silently.
 */
function scrubBuildPaths(outfile: string, dir: string): number {
  const original = readFileSync(outfile, 'utf8');
  let count = 0;

  // `__dirname` / `__filename` assignments Bun writes for CJS interop.
  let text = original.replace(
    /(__dirname|__filename)\s*=\s*"(\/[^"]*)"/g,
    (_match, name: string, abs: string) => {
      count += 1;
      const at = abs.lastIndexOf('node_modules/');
      const tail = at === -1 ? abs.slice(abs.lastIndexOf('/') + 1) : abs.slice(at);
      return `${name} = "/zveltio-extension/${tail}"`;
    },
  );

  // Bun's module comments name each input by the path it resolved, RELATIVE to
  // the package being built — `// ../../zveltio/node_modules/.bun/hono@4.13.8/…`
  // when the dependency lives in the sibling engine checkout. No home directory
  // in it, so the absolute rules above and the repo's build-path gate both let
  // it through, and it still describes the machine: the committed bundles say
  // `../wt-t4/node_modules/…`, naming a worktree that exists on one laptop.
  //
  // It also makes a bundle unreproducible. Two checkouts of the same commit,
  // differing only in directory name, pack to different bytes — so "the bundle
  // does not match its source" cannot be told from "someone packed it from a
  // worktree", and the registry refuses a republish over a difference that is
  // pure noise.
  //
  // Only runs that START with `./` or `../` are rewritten: a bundled package
  // with the literal string "node_modules/" inside its own code keeps it.
  //
  // The cut is at `.bun/` where the store layout has one, NOT at the last
  // `node_modules/`. `scripts/check-embedded-deps-fresh.ts` reads the version
  // that actually shipped out of these same comments (`.bun/hono@4.13.8/…`) —
  // it is the only gate that can see a security fix in a bundled dependency —
  // and trimming back to `node_modules/hono/dist` would leave it with nothing
  // to read and no way to say so.
  text = text.replace(
    /\.{1,2}\/[^\s"'`]*(?:node_modules|packages)\/[^\s"'`]*/g,
    (match: string) => {
      // `packages/` covers the other half: an extension imports the engine and
      // the SDK from the sibling checkout, so its bundle also carried
      // `../../zveltio/packages/sdk/src/…` — or `../wt-t4/packages/…`, which is
      // what the committed bundles say today.
      const store = match.indexOf('.bun/');
      const at =
        store === -1
          ? Math.min(
              ...[match.lastIndexOf('node_modules/'), match.indexOf('packages/')].filter(
                (i) => i >= 0,
              ),
            )
          : store;
      count += 1;
      return `/zveltio-extension/${match.slice(at)}`;
    },
  );

  // Bun writes a dependency's comment path relative to the CWD too, so the
  // same dependency appears as `../node_modules/hono/dist/…` when packing from
  // inside the extension and as `node_modules/hono/dist/…` when packing from
  // the repo root. The first form is handled above; this is the bare one.
  // Anchored to the start of a comment line so a library's own string
  // containing "node_modules/" is left alone.
  text = text.replace(/(?<=^\/\/\s*)node_modules\//gm, '/zveltio-extension/node_modules/');

  // The extension's OWN sources are named relative to the CWD, not to the
  // extension: `pack --dir workflow/checklists` from the repo root wrote
  // `// workflow/checklists/engine/index.ts` where `pack` run inside that
  // directory wrote `// engine/index.ts`. Same source, different bytes, and
  // the registry refuses different bytes at the same version — so where the
  // packer happened to stand decided whether a republish was possible.
  const prefix = relative(process.cwd(), dir).replace(/\\/g, '/');
  if (prefix && !prefix.startsWith('..')) {
    const re = new RegExp(`(?<=^//\\s*)${prefix.replace(/[.*+?^${}()|[\\]]/g, '\\$&')}/`, 'gm');
    const before = text;
    text = text.replace(re, '');
    if (text !== before) count += 1;
  }

  // Backstop for anything else carrying the home directory — Bun's resolved
  // path comments, for one. Only runs when the home directory is a real
  // absolute path, so it cannot match everything.
  const home = homedir();
  if (home && home.startsWith('/') && home.length > 1 && text.includes(home)) {
    count += text.split(home).length - 1;
    text = text.split(home).join('/zveltio-extension');
  }

  if (count > 0) writeFileSync(outfile, text, 'utf8');
  return count;
}

// Re-export for bare-import sanity check after bundle.
const CORE_DEPS = [...EXTENSION_BUNDLE_CORE_DEPS];

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export interface ExtensionPackOptions {
  dir?: string;
  sourcemap?: boolean;
  /** Don't write the manifest with engine + integrity blocks. */
  noManifestUpdate?: boolean;
  /** First-party (vendor / monorepo) — keep inline, skip the auto-inject. */
  firstParty?: boolean;
  /**
   * Keep `engine.isolation: "worker"` even when packing as first-party.
   * Without this, first-party pack clears a sticky community inject so
   * monorepo extensions do not silently stay on worker forever.
   */
  keepIsolation?: boolean;
  /** Registry token for the publisher-tier lookup. */
  token?: string;
  /** Registry base URL for the tier lookup. */
  registryUrl?: string;
}

interface Manifest {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
  engine?: {
    entry?: string;
    format?: string;
    target?: string;
    bundled?: boolean;
    bundlePeers?: boolean;
    isolation?: 'inline' | 'worker';
  };
  integrity?: {
    engineSha256?: string;
    /** Hash of the TypeScript the bundle was built from — see `hashEngineSources`. */
    sourceSha256?: string;
    archiveSha256?: string;
  };
  [k: string]: unknown;
}

/**
 * A hash of the engine sources the bundle was built from.
 *
 * `integrity.engineSha256` says the committed bundle matches what the manifest
 * declares. It cannot say the bundle matches the SOURCE, and those are
 * different claims: on 2026-08-02 three security fixes were written into
 * `content/drafts/engine/routes.ts`, committed, reviewed and merged — and never
 * ran anywhere, because nobody repacked. The bundle and the manifest agreed
 * with each other perfectly. They were simply both older than the code.
 *
 * Repacking in CI to compare bytes would be the obvious check and the wrong
 * one: bundler output is not stable across Bun versions, so it would fail for
 * reasons that have nothing to do with the author. Hashing the INPUT is
 * deterministic, needs no bundler, and answers the question actually being
 * asked — has the source moved since this artifact was built?
 *
 * Sorted by relative path so the digest does not depend on directory order,
 * and the path is hashed alongside the bytes so renaming a file counts as a
 * change. Tests are excluded: they never reach the bundle.
 */
export function hashEngineSources(dir: string): string {
  const engineDir = join(dir, 'engine');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        // `migrations/` is SQL applied by the engine, not compiled into the
        // bundle — a migration change does not invalidate the artifact.
        if (entry.name === 'migrations' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[a-z]+$/.test(entry.name)) continue;
      if (entry.name === 'index.js') continue; // the artifact itself
      files.push(full);
    }
  };
  walk(engineDir);

  const h = createHash('sha256');
  for (const f of files.sort()) {
    h.update(f.slice(engineDir.length).replace(/\\/g, '/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

function readManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(`No manifest.json at ${path}.`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function writeManifest(dir: string, m: Manifest): void {
  // Preserve key order roughly the way humans expect it: identity,
  // metadata, build config, runtime, integrity.
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

function validatePeerDeps(m: Manifest): string[] {
  const peers = Object.keys(m.peerDependencies ?? {});
  if (peers.length === 0) return [];
  const bundlePeers = m.engine?.bundlePeers === true;
  if (!bundlePeers) {
    // The compiled Bun binary can't resolve bare specifiers from
    // dynamically-imported disk files (verified live, alpha.112). Treat
    // ANY non-empty peerDependencies as a hard error unless the extension
    // explicitly opts to bundle them. Truly-native bindings (sharp) need
    // to ship via a separate mechanism — peerDependencies + external is
    // never a working production configuration on the binary install.
    return peers;
  }
  return [];
}

export async function extensionPackCommand(opts: ExtensionPackOptions): Promise<void> {
  const dir = resolve(opts.dir ?? process.cwd());
  const entry = join(dir, 'engine', 'index.ts');
  const outfile = join(dir, 'engine', 'index.js');

  if (!existsSync(entry)) {
    throw new Error(
      `No engine/index.ts at ${entry}. ` +
        `Run from the extension root or pass --dir. Extensions without an engine entry don't need pack.`,
    );
  }

  const manifest = readManifest(dir);
  console.log(`📦 Packing ${c.bold(manifest.name)} v${manifest.version}`);

  // Validate peer-deps against the allow-list. If a publisher wants to
  // ship a peer-dep that's NOT in the allow-list, they must set
  // engine.bundlePeers=true to opt into bundling it.
  const violations = validatePeerDeps(manifest);
  if (violations.length > 0) {
    throw new Error(
      `peerDependencies declared without engine.bundlePeers=true:\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        `\n\n` +
        `Bun compiled binary cannot resolve bare specifiers from a ` +
        `dynamically-imported extension bundle, so external peer deps don't ` +
        `work in production. Either set engine.bundlePeers=true in ` +
        `manifest.json (and install the deps locally so Bun.build can ` +
        `inline them), or drop the peerDependencies entry if the import ` +
        `is dead code.`,
    );
  }

  // bundlePeers=true bundles everything including peerDependencies. There
  // is no remaining "stay external" path on the binary install (see
  // PEER_DEP_ALLOWLIST comment). bundlePeers=false is rejected upstream
  // by validatePeerDeps.
  void PEER_DEP_ALLOWLIST;
  void CORE_DEPS;
  const externals: string[] = [];

  console.log(
    `  ${c.dim(`$ bun build ${entry} (zveltio extension-bundle plugin)`)}` +
      (externals.length > 0 ? c.dim(` external:${externals.join(',')}`) : ''),
  );
  try {
    await bundleExtensionEngine({
      entry,
      outfile,
      external: externals,
      sourcemap: opts.sourcemap,
      resolveDir: dir,
    });
  } catch (err) {
    throw new Error(`Bun bundle failed: ${(err as Error).message}`);
  }

  const scrubbed = scrubBuildPaths(outfile, dir);
  if (scrubbed > 0) {
    console.log(`  ${c.green('✓')} ${c.dim(`${scrubbed} build path(s) neutralised`)}`);
  }

  const bundleBytes = readFileSync(outfile);
  const engineSha256 = createHash('sha256').update(bundleBytes).digest('hex');

  // Quick sanity check: confirm core deps are NOT left as bare imports
  // in the bundle (would mean they weren't actually bundled). Strip
  // JSDoc + block comments first — bundled libraries often reproduce
  // example snippets like `* import { Hono } from 'hono'` that would
  // otherwise trip the check.
  const bundleText = bundleBytes
    .toString('utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments + JSDoc
    .replace(/(^|\s)\/\/[^\n]*/g, '$1'); // line comments

  for (const dep of CORE_DEPS) {
    const baseImportRe = new RegExp(
      `(?:from|import\\()\\s*['"]${dep.replace(/[.*+?^${}()|[\\]/g, '\\$&')}['"]`,
      'm',
    );
    if (baseImportRe.test(bundleText)) {
      throw new Error(
        `Bundled output still contains a bare import of '${dep}'. ` +
          `Bun couldn't bundle it — check that the dep is installed in node_modules ` +
          `(extension dir or a parent workspace).`,
      );
    }
  }

  const sizeKb = Math.round(bundleBytes.byteLength / 1024);
  console.log(
    `  ${c.green('✓')} ${c.bold(`engine/index.js`)} ${c.dim(`(${sizeKb} KB, sha256=${engineSha256.slice(0, 12)}…)`)}`,
  );

  // Resolve the publisher tier so community extensions get worker
  // isolation auto-injected (marketplace-policy.md §2). The engine refuses
  // inline community extensions at enable, so packing one without worker
  // produces an artifact nobody can turn on. We fix it here rather than
  // letting the author discover it after a rejected review.
  //   - explicit isolation in the manifest is always preserved (unless
  //     first-party clears a sticky worker — see resolvePackIsolation)
  //   - first-party / verified keep the inline default
  //   - community (or unresolvable tier) → inject worker, loudly
  let communityInject = false;
  if (!manifest.engine?.isolation) {
    const resolved = await resolvePublisherTier({
      firstParty: opts.firstParty,
      token: opts.token,
      registryUrl: opts.registryUrl,
    });
    if (!resolved.allowsInline) {
      communityInject = true;
      console.log(
        `  ${c.yellow('⚠')} ${resolved.tier} publisher — auto-set ${c.bold('engine.isolation: "worker"')} ` +
          `(community extensions can't run inline).`,
      );
      if (resolved.source === 'default') {
        console.log(
          c.dim(
            '    Tier defaulted to community (no --first-party flag, no registry token). ' +
              'If you are verified/first-party, pass --first-party or set ZVELTIO_REGISTRY_TOKEN.',
          ),
        );
      }
    }
  } else if (opts.firstParty && manifest.engine.isolation === 'worker' && !opts.keepIsolation) {
    console.log(
      `  ${c.yellow('⚠')} first-party pack — clearing sticky ${c.bold('engine.isolation: "worker"')} ` +
        `(inline is the first-party default). Pass ${c.bold('--keep-isolation')} to retain worker.`,
    );
  }

  const resolvedIsolation = resolvePackIsolation({
    current: manifest.engine?.isolation,
    firstParty: opts.firstParty,
    keepIsolation: opts.keepIsolation,
    communityInject,
  });

  // Patch manifest with engine + integrity blocks. archive-hash is
  // computed and written by `extension publish` later.
  if (!opts.noManifestUpdate) {
    manifest.engine = {
      entry: 'engine/index.js',
      format: 'esm',
      target: 'bun',
      bundled: true,
      bundlePeers: manifest.engine?.bundlePeers ?? false,
      // Preserve author-set or auto-injected isolation. Omitting it lets
      // the engine schema default to 'inline' (first-party / verified).
      ...(resolvedIsolation ? { isolation: resolvedIsolation } : {}),
    };
    manifest.integrity = {
      engineSha256,
      sourceSha256: hashEngineSources(dir),
      // Only carry archiveSha256 forward if a prior valid value exists —
      // never write an empty placeholder (the engine's manifest schema
      // rejects it). The registry computes archiveSha256 on upload.
      ...(manifest.integrity?.archiveSha256
        ? { archiveSha256: manifest.integrity.archiveSha256 }
        : {}),
    };
    writeManifest(dir, manifest);
    console.log(`  ${c.green('✓')} manifest.json updated with engine + integrity blocks`);
  }

  console.log(`${c.green('✓')} pack complete`);
}
