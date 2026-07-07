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

  const extNodeModules = join(workspaceRoot, 'node_modules');
  const toInstall: string[] = [];
  for (const [pkg, versionRange] of Object.entries(peerDeps)) {
    // Check via Bun's module resolution first, then fall back to a direct filesystem check
    // against the extensions node_modules (import.meta.resolve runs in engine binary context
    // and cannot see packages installed in the extensions directory).
    // Only check the extensions node_modules — import.meta.resolve runs in
    // the engine's bundle context and would find engine-bundled packages
    // (hono, zod, etc.) even though they're not available to dynamically
    // imported extension files that look up from their own directory.
    const pkgFolder = pkg.startsWith('@') ? pkg : pkg.split('/')[0];
    const alreadyInstalled = existsSync(join(extNodeModules, pkgFolder));
    if (!alreadyInstalled) {
      const spec =
        versionRange && versionRange !== '*' ? `${pkg}@${versionRange.replace(/^\^|^~/, '')}` : pkg;
      toInstall.push(spec);
    }
  }

  if (toInstall.length === 0) return;

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

  // SECURITY: validate package names and version ranges before spawning bun add.
  // A malicious manifest.json could inject shell metacharacters or use non-registry
  // protocols (file:, git:, link:) to run arbitrary code or access the filesystem.
  const SAFE_PACKAGE_NAME = /^(@[a-z0-9-_]+\/)?[a-z0-9-_.]+$/;
  const SAFE_VERSION = /^[\d.*^~>=<| -]+$/;
  for (const [pkg, ver] of Object.entries(peerDeps)) {
    if (!SAFE_PACKAGE_NAME.test(pkg) || !SAFE_VERSION.test(ver)) {
      throw new Error(
        `Extension "${extName}" declared unsafe peerDependency: "${pkg}@${ver}". ` +
          `Only scoped/unscoped npm package names with semver ranges are allowed.`,
      );
    }
    // SECURITY: enforce platform allow-list. Unknown packages cannot be auto-installed
    // — a publisher must request inclusion in peer-deps-allowlist.ts via PR review.
    if (!isPackageAllowed(pkg)) {
      throw new Error(
        `Extension "${extName}" declared disallowed peerDependency: "${pkg}". ` +
          `Only packages on the platform allow-list may be auto-installed. ` +
          `See packages/engine/src/lib/peer-deps-allowlist.ts to request inclusion.`,
      );
    }
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
