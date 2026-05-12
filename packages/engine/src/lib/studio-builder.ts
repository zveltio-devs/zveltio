/**
 * studio-builder — "Rebuild at install" Studio integration.
 *
 * When an extension with a `studio/pages/` directory is enabled and
 * STUDIO_SRC_DIR is set, this module:
 *   1. Copies the extension's `studio/pages/` into the Studio SvelteKit route tree.
 *   2. Copies the extension's `studio/src/` components into `$lib/ext/<name>/`.
 *   3. Runs `bun run build` inside STUDIO_SRC_DIR.
 *   4. Replaces the live Studio dist with the fresh build output.
 *
 * If STUDIO_SRC_DIR is not set the function returns immediately — the Studio
 * is served as a pre-built static artifact and no rebuild is possible.
 */

import { existsSync, mkdirSync, cpSync, rmSync, renameSync, readFileSync } from 'fs';
import { join } from 'path';

function studioSrcDir(): string | null {
  return process.env.STUDIO_SRC_DIR ?? null;
}

function studioDistDir(): string {
  return process.env.STUDIO_DIST_PATH ?? join(process.cwd(), 'studio-dist');
}

/**
 * Rebuild the Studio SPA for all active extensions that have a `studio/pages/` directory.
 * Called after enable/disable so the compiled routes stay in sync with active extensions.
 *
 * @param activeExtNames - names of currently active extensions (post enable/disable)
 * @param extensionsBase  - root directory where extensions are stored
 */
export async function rebuildStudio(
  activeExtNames: string[],
  extensionsBase: string,
): Promise<{ rebuilt: boolean; error?: string }> {
  // Docker mode: delegate rebuild to the studio-builder sidecar container
  const builderUrl = process.env.STUDIO_BUILDER_URL;
  if (builderUrl) {
    try {
      const res = await fetch(`${builderUrl}/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensions: activeExtNames }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        return { rebuilt: false, error: `Builder returned ${res.status}: ${err.slice(0, 200)}` };
      }
      console.log('[studio-builder] Rebuild delegated to builder container — success.');
      return { rebuilt: true };
    } catch (err) {
      return { rebuilt: false, error: `Builder unreachable: ${(err as Error).message}` };
    }
  }

  // Local mode: requires STUDIO_SRC_DIR
  const srcDir = studioSrcDir();
  if (!srcDir || !existsSync(srcDir)) {
    // STUDIO_SRC_DIR not configured or not found — skip silently
    return { rebuilt: false };
  }

  const extRoutesBase = join(srcDir, 'src', 'routes', '(admin)', 'extensions');
  const extLibBase    = join(srcDir, 'src', 'lib', 'ext');

  // Collect extensions that have studio source to integrate
  const toIntegrate: Array<{ name: string; pagesDir: string; srcDir?: string }> = [];

  for (const name of activeExtNames) {
    const extDir   = join(extensionsBase, name);
    const pagesDir = join(extDir, 'studio', 'pages');
    const compDir  = join(extDir, 'studio', 'src');
    if (existsSync(pagesDir)) {
      toIntegrate.push({ name, pagesDir, srcDir: existsSync(compDir) ? compDir : undefined });
    }
  }

  if (toIntegrate.length === 0) {
    return { rebuilt: false }; // nothing to do
  }

  // Copy extension pages + components into Studio source tree
  for (const { name, pagesDir, srcDir: compDir } of toIntegrate) {
    // Derive route slug from manifest studio.pages[0].path so it matches
    // what the sidebar nav generates (e.g. /admin/mail → "mail", not "communications/mail").
    let slug = name;
    const manifestPath = join(extensionsBase, name, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          studio?: { pages?: Array<{ path: string }> };
        };
        const firstPage = m.studio?.pages?.[0];
        if (firstPage?.path) {
          slug = firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '');
        }
      } catch { /* use name as slug */ }
    }
    const routeDest = join(extRoutesBase, slug);
    const libDest   = join(extLibBase, name);

    mkdirSync(routeDest, { recursive: true });
    cpSync(pagesDir, routeDest, { recursive: true });

    if (compDir) {
      mkdirSync(libDest, { recursive: true });
      cpSync(compDir, libDest, { recursive: true });
    }
  }

  // Run bun run build inside Studio source dir
  const build = Bun.spawn(['bun', 'run', 'build'], {
    cwd: srcDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await build.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(build.stderr).text();
    console.error('[studio-builder] Build failed:\n', stderr);
    return { rebuilt: false, error: `Studio build exited with code ${exitCode}: ${stderr.slice(0, 500)}` };
  }

  // Swap dist: rename old → backup, move new → live, remove backup
  const newDist  = join(srcDir, 'dist');
  const liveDist = studioDistDir();
  const bakDist  = liveDist + '.bak';

  if (!existsSync(newDist)) {
    return { rebuilt: false, error: 'Build succeeded but dist/ not found' };
  }

  try {
    if (existsSync(bakDist)) rmSync(bakDist, { recursive: true, force: true });
    if (existsSync(liveDist)) renameSync(liveDist, bakDist);
    cpSync(newDist, liveDist, { recursive: true });
    if (existsSync(bakDist)) rmSync(bakDist, { recursive: true, force: true });
    console.log('[studio-builder] Studio rebuilt and swapped successfully.');
    return { rebuilt: true };
  } catch (err) {
    // Attempt rollback
    if (!existsSync(liveDist) && existsSync(bakDist)) {
      try { renameSync(bakDist, liveDist); } catch { /* ignore */ }
    }
    return { rebuilt: false, error: (err as Error).message };
  }
}
