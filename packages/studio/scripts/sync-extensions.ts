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
/** Destination slugs written this run — verified against biome ignores below. */
const syncedSlugs: string[] = [];

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
      // Skip the extension's own tests. They belong to the extensions repo and
      // run under `bun test` there; copied into the Studio tree they get picked
      // up by vitest, which cannot resolve `bun:test`, and by `tsc`, which fails
      // on the same import — a green extension suite turning the Studio red.
      cpSync(srcDir, libDest, {
        recursive: true,
        filter: (src) => !/\.(test|spec)\.(ts|js|svelte)$/.test(src),
      });
    }

    console.log(`[sync-ext] ✓  ${extName} → ${slug}/`);
    syncedSlugs.push(slug);
    synced++;
  }
}

/**
 * Everything written above is GENERATED — a verbatim copy of code authored in
 * zveltio-extensions. It used to be biome-formatted here so the committed
 * snapshot would match a re-sync, but that only ever papered over the real
 * issue: the tree was also being linted and hand-edited as if it were source
 * (the H-01 any-ratchet wrote 576 suppression comments into it), so a re-sync
 * silently reverted those edits and left the repo dirty and lint-failing.
 *
 * It is now excluded from biome entirely via `files.includes` negations, the
 * same way studio-dist and the other generated trees are. That makes the raw
 * copy the committed state, so sync is idempotent by construction with no
 * formatting pass and no suppressions to strip.
 *
 * The one way that can rot is a NEW extension page landing on a slug nobody
 * added to the ignore list. Check it here and fail loudly — a silent miss means
 * a permanently dirty working tree and a red lint job for whoever hits it next.
 */
if (synced > 0) {
  const biomePath = join(STUDIO_ROOT, '../../biome.json');
  try {
    const biome = JSON.parse(await Bun.file(biomePath).text()) as {
      files?: { includes?: string[] };
    };
    const ignored = new Set(
      (biome.files?.includes ?? []).filter((p) => p.startsWith('!packages/studio/')),
    );
    const missing = syncedSlugs.filter(
      (slug) => !ignored.has(`!packages/studio/src/routes/(admin)/${slug}/**`),
    );
    if (missing.length > 0) {
      console.error(
        `\n[sync-ext] ${missing.length} synced route(s) are not excluded from biome.\n` +
          'These are generated files; linting them makes every build dirty.\n' +
          'Add to biome.json "files.includes" AND scripts/lib/any-targets.ts EXCLUDE:\n' +
          missing.map((s) => `  "!packages/studio/src/routes/(admin)/${s}/**"`).join('\n') +
          '\n',
      );
      process.exit(1);
    }
  } catch (e) {
    console.warn('[sync-ext] could not verify biome ignores:', (e as Error).message);
  }
}

console.log(`[sync-ext] Done — ${synced} extension page(s) synced.`);
