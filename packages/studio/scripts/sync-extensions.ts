#!/usr/bin/env bun
/**
 * Copies studio/pages/ from each extension into the Studio SvelteKit route tree.
 * The destination slug is derived from manifest.studio.pages[0].path so it
 * matches what the sidebar nav generates (e.g. /extensions/mail, /extensions/developer/graphql).
 *
 * Run automatically as `prebuild`. Safe to run multiple times (overwrites).
 */

import { existsSync, mkdirSync, cpSync, readdirSync } from 'fs';
import { join } from 'path';

const STUDIO_ROOT = join(import.meta.dir, '..');

// Extension roots to scan, in priority order.
const EXT_ROOTS = [
  // Dev: zveltio-extensions is a sibling of the zveltio monorepo repo
  // packages/studio → packages → zveltio → zveltio-ecosystem → zveltio-extensions
  join(STUDIO_ROOT, '../../../zveltio-extensions'),
  // Production: EXTENSIONS_DIR env (set by install.sh or admin)
  process.env.EXTENSIONS_DIR ?? '',
]
  .filter(Boolean)
  .filter((p) => existsSync(p as string)) as string[];

const ROUTES_EXT = join(STUDIO_ROOT, 'src/routes/(admin)');
const LIB_EXT = join(STUDIO_ROOT, 'src/lib/ext');

// Docker builder sets SKIP_SYNC_EXT=1 because it runs sync inline before build
if (process.env.SKIP_SYNC_EXT === '1') {
  console.log('[sync-ext] SKIP_SYNC_EXT set — skipping (Docker builder mode).');
  process.exit(0);
}

if (EXT_ROOTS.length === 0) {
  console.log('[sync-ext] No extension directory found — skipping.');
  process.exit(0);
}

function findExtensions(base: string, prefix = ''): string[] {
  const names: string[] = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const manifestPath = join(base, entry.name, 'manifest.json');
    if (existsSync(manifestPath)) {
      names.push(rel);
    } else {
      // Recurse into category directories (e.g. compliance/ro/)
      names.push(...findExtensions(join(base, entry.name), rel));
    }
  }
  return names;
}

let synced = 0;

for (const extRoot of EXT_ROOTS) {
  const extensions = findExtensions(extRoot);

  for (const extName of extensions) {
    const pagesDir = join(extRoot, extName, 'studio', 'pages');
    if (!existsSync(pagesDir)) continue;

    const manifestPath = join(extRoot, extName, 'manifest.json');
    let slug = extName; // fallback: use extension name as slug

    try {
      const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
        studio?: { pages?: Array<{ path: string }> };
      };
      const firstPage = manifest.studio?.pages?.[0];
      if (firstPage?.path) {
        // /admin/mail → mail | /admin/developer/graphql → developer/graphql
        slug = firstPage.path.replace(/^\/admin\//, '').replace(/^\//, '');
      }
    } catch {
      // use name as slug
    }

    const dest = join(ROUTES_EXT, slug);
    mkdirSync(dest, { recursive: true });
    cpSync(pagesDir, dest, { recursive: true });

    // Also copy studio/src/ (shared components, libs) → $lib/ext/<name>/ so
    // pages can import them via $lib/ext/<extName>/components/Foo.svelte.
    // This mirrors what the runtime studio-builder.ts does for installed
    // extensions; keeps dev parity with prod hot-install flow.
    const srcDir = join(extRoot, extName, 'studio', 'src');
    if (existsSync(srcDir)) {
      const libDest = join(LIB_EXT, extName);
      mkdirSync(libDest, { recursive: true });
      cpSync(srcDir, libDest, { recursive: true });
    }

    console.log(`[sync-ext] ✓  ${extName} → ${slug}/`);
    synced++;
  }
}

// Format the freshly-copied files. Extension sources in zveltio-extensions
// aren't necessarily biome-formatted, so a raw copy leaves the tracked
// route/lib snapshot dirty after every build (and drifting from what CI's
// format:check expects). Formatting here makes `sync-ext` idempotent: the
// committed snapshot == what a re-sync produces == biome-clean. Skipped when
// nothing synced (e.g. release runner with no extensions sibling — it serves
// the committed snapshot untouched).
if (synced > 0) {
  try {
    const proc = Bun.spawn(
      ['bunx', 'biome', 'format', '--write', 'src/routes/(admin)', 'src/lib/ext'],
      { cwd: STUDIO_ROOT, stdout: 'inherit', stderr: 'inherit' },
    );
    const code = await proc.exited;
    if (code !== 0) console.warn(`[sync-ext] biome format exited ${code}`);
  } catch (e) {
    console.warn('[sync-ext] biome format skipped:', (e as Error).message);
  }
}

console.log(`[sync-ext] Done — ${synced} extension page(s) synced.`);
