// Core npm-dependency provisioning for extensions.
//
// Extracted from extension-loader.ts (loader split). Installs the core packages
// (`hono`, `zod`, `kysely`, `@hono/zod-validator`) into
// `<EXTENSIONS_DIR>/node_modules/` at first startup and makes them visible to the
// compiled binary's module resolver via a CWD-level symlink. Self-contained
// install-time filesystem code; no loader state.

import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import enginePkg from '../../../package.json' with { type: 'json' };

/**
 * When running as a compiled binary (e.g. /opt/zveltio/zveltio), Bun resolves
 * dynamic-import module specifiers starting from the process's working directory,
 * not from the imported file's filesystem location.  The extensions live under
 * EXTENSIONS_DIR (e.g. /opt/zveltio/extensions/) but the binary's CWD is typically
 * one level up (/opt/zveltio/).  A symlink from CWD/node_modules to
 * extBase/node_modules makes all packages installed by ensureExtensionCoreDeps and
 * installNpmDependencies visible to the binary's module resolver.
 */
export function maybeSymlinkNodeModules(extBase: string): void {
  const extModules = join(extBase, 'node_modules');
  const cwdModules = join(process.cwd(), 'node_modules');
  if (extModules === cwdModules) return; // already the same location
  if (existsSync(cwdModules)) return; // already exists (real dir or prior symlink)
  try {
    symlinkSync(extModules, cwdModules);
  } catch (err) {
    // Non-fatal — fail loud so operators can investigate. Without this
    // symlink, dynamic-import resolution of `kysely`/`hono` from
    // extension files won't find the packages installed under
    // <EXTENSIONS_DIR>/node_modules/.
    console.warn(
      `[extensions] failed to symlink ${cwdModules} → ${extModules}: ${(err as Error).message}. ` +
        `Extensions importing bare specifiers (kysely, hono, …) may fail to load.`,
    );
  }
}

export async function ensureExtensionCoreDeps(extBase: string): Promise<void> {
  const honoPath = join(extBase, 'node_modules', 'hono');
  if (existsSync(honoPath)) {
    maybeSymlinkNodeModules(extBase);
    return;
  }

  const pkgJsonPath = join(extBase, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'zveltio-extensions',
          private: true,
          type: 'module',
          dependencies: CORE_DEP_RANGES,
        },
        null,
        2,
      ),
    );
  }

  console.log('[extensions] Installing core packages (first-time setup)…');

  if (await tryBunInstall(extBase)) {
    console.log('[extensions] Core packages installed via bun.');
    maybeSymlinkNodeModules(extBase);
    return;
  }

  console.log('[extensions] bun CLI unavailable; fetching tarballs from npm registry…');
  try {
    await installCorePackagesFromNpm(extBase);
    console.log('[extensions] Core packages installed via npm tarball fetch.');
  } catch (err) {
    console.warn('[extensions] Core package install failed:', (err as Error).message);
    console.warn(
      '[extensions] Extensions with engine routes will not load. Install bun or run `npm install` in',
      extBase,
    );
  }
  maybeSymlinkNodeModules(extBase);
}

async function tryBunInstall(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['bun', 'install'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    // ENOENT — bun not on PATH (typical for compiled-binary production installs)
    return false;
  }
}

export const CORE_NPM_PACKAGES = ['hono', 'zod', 'kysely', '@hono/zod-validator'];

/**
 * The engine's own ranges for the core packages, read from its package.json.
 * Hand-written copies drifted: a fresh install got kysely ^0.27.6 while the
 * engine ran ^0.29.6, and the tarball fallback took whatever `latest` was.
 */
export const CORE_DEP_RANGES: Record<string, string> = Object.fromEntries(
  CORE_NPM_PACKAGES.map((pkg) => [pkg, (enginePkg.dependencies as Record<string, string>)[pkg]]),
);

/**
 * Direct npm install fallback for production compiled binaries.
 * For each core package:
 *   1. GET https://registry.npmjs.org/<name>/<version> → metadata with tarball URL.
 *      The registry does not resolve ranges, so <version> is the lower bound of
 *      the engine's own range — the version it was built against, never `latest`.
 *   2. Download tarball
 *   3. Extract via system `tar` into node_modules/<name>/, stripping the
 *      'package/' top-level directory that npm tarballs always contain
 *
 * These 4 packages have zero runtime dependencies between them (zod-validator
 * lists hono and zod as peer deps which we install separately), so we don't
 * need a full dependency resolver.
 */
async function installCorePackagesFromNpm(extBase: string): Promise<void> {
  const nodeModules = join(extBase, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });

  for (const pkg of CORE_NPM_PACKAGES) {
    const version = CORE_DEP_RANGES[pkg]?.replace(/^[\^~]/, '');
    const metaRes = await fetch(`https://registry.npmjs.org/${pkg}/${version}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!metaRes.ok) {
      throw new Error(`npm metadata fetch failed for ${pkg}: ${metaRes.status}`);
    }
    const meta = (await metaRes.json()) as { version: string; dist: { tarball: string } };

    const tarRes = await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(60_000) });
    if (!tarRes.ok) {
      throw new Error(`tarball download failed for ${pkg}@${meta.version}: ${tarRes.status}`);
    }
    const buf = Buffer.from(await tarRes.arrayBuffer());

    const targetDir = join(nodeModules, pkg);
    mkdirSync(targetDir, { recursive: true });

    // Stage the tarball next to the target so concurrent extractions don't collide.
    const tmpFile = join(nodeModules, `.${pkg.replace('/', '__')}.tgz`);
    writeFileSync(tmpFile, buf);

    const proc = Bun.spawn(['tar', '-xzf', tmpFile, '-C', targetDir, '--strip-components=1'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore cleanup error */
    }

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar extraction failed for ${pkg}: ${stderr.trim() || `exit ${exitCode}`}`);
    }

    console.log(`[extensions]   ✓ ${pkg}@${meta.version}`);
  }
}
