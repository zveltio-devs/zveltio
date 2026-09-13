/**
 * Install an extension's npm peerDependencies at enable time.
 *
 * Extracted from `extension-loader.ts` (H-04 split). Pure function — no loader
 * state. Installs into the extensions base `node_modules` (co-located with the
 * core deps) so dynamically-imported extension modules resolve them via the
 * normal filesystem walk. Fail-closed: an extension whose peers can't be
 * installed throws (it would crash at import time otherwise).
 *
 * Security: package names + version ranges are validated against strict
 * patterns and an allow-list (`peer-deps-allowlist.ts`) before any spawn, so a
 * malicious manifest can't inject shell metacharacters or non-registry
 * protocols (file:/git:/link:).
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExtensionsBase } from './extension-paths.js';
import { isPackageAllowed } from '../peer-deps-allowlist.js';

export async function installExtensionNpmDependencies(
  extName: string,
  peerDeps: Record<string, string>,
): Promise<void> {
  // Install into the extensions base directory — the same place ensureExtensionCoreDeps
  // puts hono/zod/kysely so that dynamically-imported extension modules can resolve all
  // packages via the standard Node.js filesystem walk from their location.
  // Using resolveExtensionsBase() keeps peerDeps co-located with core deps and works
  // correctly whether running as a compiled binary, in dev, or inside Docker.
  const workspaceRoot = resolveExtensionsBase();

  // SECURITY: reject a package NAME shape that isn't a plain npm identifier
  // before anything below derives a filesystem path from it. This must run
  // over EVERY declared peer, unconditionally, before the "already installed?"
  // check further down — that check resolves `pkg` into a directory name and
  // asks `existsSync`, and an unvalidated `pkg` containing a path separator
  // (e.g. "../pwn") resolved to a directory that always exists (an ancestor of
  // `extNodeModules`). That marked the peer "already installed" and skipped it
  // from `toInstall`, so when it was the only declared peer the function
  // returned before the allow-list check further down ever ran for it —
  // silently, with no error surfaced.
  const SAFE_PACKAGE_NAME = /^(@[a-z0-9-_]+\/)?[a-z0-9-_.]+$/;
  for (const pkg of Object.keys(peerDeps)) {
    if (!SAFE_PACKAGE_NAME.test(pkg)) {
      throw new Error(
        `Extension "${extName}" declared unsafe peerDependency: "${pkg}@${peerDeps[pkg]}". ` +
          `Only scoped/unscoped npm package names with semver ranges are allowed.`,
      );
    }
  }

  const extNodeModules = join(workspaceRoot, 'node_modules');
  const pending: Array<{ pkg: string; versionRange: string }> = [];
  for (const [pkg, versionRange] of Object.entries(peerDeps)) {
    // Check via Bun's module resolution first, then fall back to a direct filesystem check
    // against the extensions node_modules (import.meta.resolve runs in engine binary context
    // and cannot see packages installed in the extensions directory).
    // Only check the extensions node_modules — import.meta.resolve runs in
    // the engine's bundle context and would find engine-bundled packages
    // (hono, zod, etc.) even though they're not available to dynamically
    // imported extension files that look up from their own directory.
    // Safe to derive the folder from `pkg` here: SAFE_PACKAGE_NAME above has
    // already rejected any name containing a path separator outside the
    // single `@scope/name` form.
    const pkgFolder = pkg.startsWith('@') ? pkg : pkg.split('/')[0];
    const alreadyInstalled = existsSync(join(extNodeModules, pkgFolder));
    if (!alreadyInstalled) pending.push({ pkg, versionRange });
  }

  if (pending.length === 0) return;

  // SECURITY: validate version ranges and enforce the platform allow-list for
  // every peer that is actually about to be installed — i.e. before spawning
  // `bun add` / `npm install`. A malicious manifest.json could otherwise inject
  // shell metacharacters via the version range, or pull in an arbitrary
  // unreviewed npm package (a supply-chain vector); an unknown package cannot
  // be auto-installed — a publisher must request inclusion in
  // peer-deps-allowlist.ts via PR review. Scoped to `pending` (peers not yet
  // satisfied on disk), not every declared peer, so a peer already satisfied —
  // e.g. a core dep like `hono` also declared as a peerDependency — doesn't
  // have to additionally appear on the allow-list.
  const SAFE_VERSION = /^[\d.*^~>=<| -]+$/;
  for (const { pkg, versionRange } of pending) {
    if (!SAFE_VERSION.test(versionRange)) {
      throw new Error(
        `Extension "${extName}" declared unsafe peerDependency: "${pkg}@${versionRange}". ` +
          `Only scoped/unscoped npm package names with semver ranges are allowed.`,
      );
    }
    if (!isPackageAllowed(pkg)) {
      throw new Error(
        `Extension "${extName}" declared disallowed peerDependency: "${pkg}". ` +
          `Only packages on the platform allow-list may be auto-installed. ` +
          `See packages/engine/src/lib/peer-deps-allowlist.ts to request inclusion.`,
      );
    }
  }

  const toInstall = pending.map(({ pkg, versionRange }) =>
    versionRange && versionRange !== '*' ? `${pkg}@${versionRange.replace(/^\^|^~/, '')}` : pkg,
  );

  // Ensure a package.json exists in the install dir so `bun add` works.
  const pkgJsonPath = join(workspaceRoot, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'zveltio-extensions',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
    );
  }

  console.log(`📦 Extension "${extName}": installing npm packages: ${toInstall.join(', ')}`);

  // Try bun add first; fall back to npm install if bun is not on PATH
  let installed = false;

  try {
    const proc = Bun.spawn(['bun', 'add', ...toInstall], {
      cwd: workspaceRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      installed = true;
    } else {
      const stderr = await new Response(proc.stderr).text();
      console.warn(`[extensions] bun add failed for "${extName}": ${stderr.trim()}`);
    }
  } catch {
    // ENOENT — bun not on PATH; try npm
  }

  if (!installed) {
    try {
      const npmProc = Bun.spawn(['npm', 'install', '--save', ...toInstall], {
        cwd: workspaceRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await npmProc.exited;
      if (exitCode === 0) {
        installed = true;
      } else {
        const stderr = await new Response(npmProc.stderr).text();
        console.warn(`[extensions] npm install failed for "${extName}": ${stderr.trim()}`);
      }
    } catch {
      // npm not on PATH either
    }
  }

  if (!installed) {
    // S1-02: fail-close. Previously this was a warning + return, but an
    // extension whose peerDeps fail to install will crash at runtime when it
    // tries to import the missing module. Surface the failure now so the
    // install / enable HTTP response carries an actionable error to the user.
    throw new Error(
      `Extension "${extName}": could not install peer packages ${toInstall.join(', ')}. ` +
        `Install them manually in ${workspaceRoot}: bun add ${toInstall.join(' ')}`,
    );
  }

  console.log(`✅ Extension "${extName}": packages installed successfully`);
}
