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
 * the binary install — see docs/EXTENSIONS-V2-PHASE1.md §2.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bundleExtensionEngine, EXTENSION_BUNDLE_CORE_DEPS } from '../lib/extension-bundle.js';

// Native + oversized deps that DON'T bundle cleanly. Stay external at
// build time; the engine installs them at enable. Keep this list in
// sync with the engine's CORE_NPM_PACKAGES + native-binding allow-list
// referenced by the manifest schema's `peerDependencies` description.
const PEER_DEP_ALLOWLIST = new Set([
  // Communication / mail
  'imapflow',
  'mailparser',
  'nodemailer',
  // SAML/LDAP/auth
  'ldapts',
  'samlify',
  'node-saml',
  '@node-saml/node-saml',
  // Image processing
  'sharp',
  // PDF / docs
  'pdfkit',
  'puppeteer',
  // Cloud SDKs (oversized)
  '@aws-sdk/client-s3',
  '@aws-sdk/client-textract',
  // Storage / queues
  'redis',
  'ioredis',
  '@aws-sdk/client-sqs',
]);

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
  };
  integrity?: {
    engineSha256?: string;
    archiveSha256?: string;
  };
  [k: string]: unknown;
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
  const bundlePeers = m.engine?.bundlePeers === true;
  if (bundlePeers) return []; // when bundling all peers, no allow-list constraint
  return peers.filter((p) => !PEER_DEP_ALLOWLIST.has(p));
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
      `peerDependencies contains packages outside the allow-list:\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        `\n\n` +
        `Either remove them, add to the engine's allow-list, or set ` +
        `engine.bundlePeers = true to bundle them into engine/index.js.`,
    );
  }

  // Externals: core deps are BUNDLED (so removed from externals);
  // allow-list peer-deps stay external unless bundlePeers=true.
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const externals: string[] =
    manifest.engine?.bundlePeers === true
      ? [] // bundle EVERYTHING
      : peers.filter((p) => PEER_DEP_ALLOWLIST.has(p)); // keep allow-listed peers external
  void CORE_DEPS;

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

  // Patch manifest with engine + integrity blocks. archive-hash is
  // computed and written by `extension publish` later.
  if (!opts.noManifestUpdate) {
    manifest.engine = {
      entry: 'engine/index.js',
      format: 'esm',
      target: 'bun',
      bundled: true,
      bundlePeers: manifest.engine?.bundlePeers ?? false,
    };
    manifest.integrity = {
      engineSha256,
      archiveSha256: manifest.integrity?.archiveSha256 ?? '',
    };
    writeManifest(dir, manifest);
    console.log(`  ${c.green('✓')} manifest.json updated with engine + integrity blocks`);
  }

  console.log(`${c.green('✓')} pack complete`);
}
