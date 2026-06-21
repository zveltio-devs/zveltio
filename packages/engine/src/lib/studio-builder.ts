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

// Install-time sync filesystem ops (cp/rm/rename/read) for the Studio
// rebuild pipeline. Bun.file is async-only, so we use node:fs here —
// the `node:` prefix flags this as "intentionally not Bun.file" rather
// than an accidental Node.js import.
import { existsSync, mkdirSync, cpSync, rmSync, renameSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'path';

function studioSrcDir(): string | null {
  return process.env.STUDIO_SRC_DIR ?? null;
}

function studioDistDir(): string {
  return process.env.STUDIO_DIST_PATH ?? join(process.cwd(), 'studio-dist');
}

// ─── Rebuild coalescing (alpha.126) ──────────────────────────────────
//
// Each marketplace enable/disable used to trigger an immediate full
// Vite build (5–15s). Operators that enable five extensions back-to-back
// burned 5 × 15s of CPU + I/O instead of 1 × 15s. The host now
// debounces rebuild requests: a call schedules a build after a short
// quiet window, and overlapping calls return the same in-flight
// promise. The "what's actually changing" check below also short-
// circuits when the resolved input set hashes to the same value as
// the last successful build — common when enable racing with
// re-broadcasts.
const REBUILD_DEBOUNCE_MS = 750;
let _pendingRebuild: {
  promise: Promise<{ rebuilt: boolean; error?: string }>;
  resolve: (v: { rebuilt: boolean; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  latestArgs: { extNames: string[]; extensionsBase: string };
} | null = null;
let _lastSuccessfulInputHash: string | null = null;

async function studioInputHash(activeExtNames: string[], extensionsBase: string): Promise<string> {
  const h = createHash('sha256');
  const sorted = [...activeExtNames].sort();
  h.update(sorted.join('\n'));
  for (const name of sorted) {
    const pagesDir = join(extensionsBase, name, 'studio', 'pages');
    if (!existsSync(pagesDir)) continue;
    h.update(`|${name}|`);
    try {
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full);
          } else {
            const s = statSync(full);
            h.update(`${full}|${s.size}|${s.mtimeMs}|`);
          }
        }
      };
      await walk(pagesDir);
    } catch {
      /* ignore — best effort */
    }
  }
  return h.digest('hex');
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
  // Coalesce multiple back-to-back enables into a single build. Each
  // call within REBUILD_DEBOUNCE_MS of the previous call shares the
  // same in-flight promise; the latest arguments win.
  if (_pendingRebuild) {
    _pendingRebuild.latestArgs = { extNames: activeExtNames, extensionsBase };
    clearTimeout(_pendingRebuild.timer);
    _pendingRebuild.timer = setTimeout(() => void runDebouncedRebuild(), REBUILD_DEBOUNCE_MS);
    return _pendingRebuild.promise;
  }
  let resolve!: (v: { rebuilt: boolean; error?: string }) => void;
  const promise = new Promise<{ rebuilt: boolean; error?: string }>((r) => {
    resolve = r;
  });
  _pendingRebuild = {
    promise,
    resolve,
    timer: setTimeout(() => void runDebouncedRebuild(), REBUILD_DEBOUNCE_MS),
    latestArgs: { extNames: activeExtNames, extensionsBase },
  };
  return promise;
}

async function runDebouncedRebuild(): Promise<void> {
  if (!_pendingRebuild) return;
  const { latestArgs, resolve } = _pendingRebuild;
  _pendingRebuild = null;
  const result = await rebuildStudioImpl(latestArgs.extNames, latestArgs.extensionsBase);
  resolve(result);
}

async function rebuildStudioImpl(
  activeExtNames: string[],
  extensionsBase: string,
): Promise<{ rebuilt: boolean; error?: string }> {
  // Skip if the input set hashes to the last successful build's hash.
  // Common when ENABLE racing re-broadcasts (e.g. websocket-driven
  // refresh fires rebuild even though nothing about the page tree
  // actually changed).
  try {
    const inputHash = await studioInputHash(activeExtNames, extensionsBase);
    if (inputHash === _lastSuccessfulInputHash) {
      console.log('[studio-builder] inputs unchanged since last build — skipping rebuild');
      return { rebuilt: true };
    }
  } catch {
    /* hash failure → proceed with rebuild */
  }

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

  const extRoutesBase = join(srcDir, 'src', 'routes', '(admin)');
  const extLibBase = join(srcDir, 'src', 'lib', 'ext');

  // Collect extensions that have studio source to integrate
  const toIntegrate: Array<{ name: string; pagesDir: string; srcDir?: string }> = [];

  for (const name of activeExtNames) {
    const extDir = join(extensionsBase, name);
    const pagesDir = join(extDir, 'studio', 'pages');
    const compDir = join(extDir, 'studio', 'src');
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
      } catch {
        /* use name as slug */
      }
    }
    const routeDest = join(extRoutesBase, slug);
    const libDest = join(extLibBase, name);

    mkdirSync(routeDest, { recursive: true });
    cpSync(pagesDir, routeDest, { recursive: true });

    if (compDir) {
      mkdirSync(libDest, { recursive: true });
      cpSync(compDir, libDest, { recursive: true });
    }
  }

  // Ensure build dependencies exist. A fresh install may have skipped or
  // failed `bun install` (network blip, swallowed error) — without it the
  // build dies immediately ("cannot find vite"). Install on demand so the
  // first rebuild self-heals instead of leaving the operator stuck.
  if (!existsSync(join(srcDir, 'node_modules'))) {
    console.log('[studio-builder] node_modules missing — running bun install first…');
    const install = Bun.spawn(['bun', 'install'], {
      cwd: srcDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
    });
    const installCode = await install.exited;
    if (installCode !== 0) {
      const stderr = await new Response(install.stderr).text();
      console.error('[studio-builder] bun install failed:\n', stderr);
      return {
        rebuilt: false,
        error: `Studio dependency install failed (code ${installCode}): ${stderr.slice(0, 300)}`,
      };
    }
  }

  // Run bun run build inside Studio source dir. Pages are already copied
  // above — skip prebuild sync to avoid double-copy and permission races.
  const build = Bun.spawn(['bun', 'run', 'build'], {
    cwd: srcDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      EXTENSIONS_DIR: extensionsBase,
      SKIP_SYNC_EXT: '1',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    },
  });

  const exitCode = await build.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(build.stderr).text();
    console.error('[studio-builder] Build failed:\n', stderr);
    return {
      rebuilt: false,
      error: `Studio build exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
    };
  }

  // Swap dist: rename old → backup, move new → live, remove backup
  const newDist = join(srcDir, 'dist');
  const liveDist = studioDistDir();
  const bakDist = liveDist + '.bak';

  if (!existsSync(newDist)) {
    return { rebuilt: false, error: 'Build succeeded but dist/ not found' };
  }

  try {
    if (existsSync(bakDist)) rmSync(bakDist, { recursive: true, force: true });
    if (existsSync(liveDist)) renameSync(liveDist, bakDist);
    cpSync(newDist, liveDist, { recursive: true });
    if (existsSync(bakDist)) rmSync(bakDist, { recursive: true, force: true });
    // Cache the input hash so the next call with identical inputs
    // short-circuits at the top of rebuildStudioImpl.
    try {
      _lastSuccessfulInputHash = await studioInputHash(activeExtNames, extensionsBase);
    } catch {
      _lastSuccessfulInputHash = null;
    }
    console.log('[studio-builder] Studio rebuilt and swapped successfully.');
    return { rebuilt: true };
  } catch (err) {
    // Attempt rollback
    if (!existsSync(liveDist) && existsSync(bakDist)) {
      try {
        renameSync(bakDist, liveDist);
      } catch {
        /* ignore */
      }
    }
    return { rebuilt: false, error: (err as Error).message };
  }
}
