#!/usr/bin/env bun
/**
 * Copies studio/pages/ from each extension into the Studio SvelteKit route tree.
 * The destination slug is derived from manifest.studio.pages[0].path so it
 * matches what the sidebar nav generates (e.g. /extensions/mail, /extensions/developer/graphql).
 *
 * Run automatically as `prebuild`. Safe to run multiple times (overwrites).
 */

import { copyFileSync, existsSync, mkdirSync, cpSync, readdirSync, realpathSync, rmSync } from 'fs';
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
  .filter((p) => existsSync(p as string))
  // Both entries routinely name the SAME directory: in dev, EXTENSIONS_DIR is
  // usually set to the sibling checkout the first entry already points at. The
  // loop below has no per-slug guard, so an extension found under two roots was
  // synced twice and its slug written into .synced.json twice — 42 entries for
  // 21 pages. Harmless to the copy (it is idempotent), but it made the
  // generated snapshot depend on whether an env var happened to be set, so two
  // people regenerating it produced different files and every merge conflicted.
  // Compare by resolved path, since the two spellings differ textually.
  .filter(
    (p, i, all) =>
      all.findIndex((q) => realpathSync(q as string) === realpathSync(p as string)) === i,
  ) as string[];

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

/**
 * Copy `from` into `to`, overwriting, skipping the extension's own tests.
 *
 * Written out by hand because `cpSync(from, to, { recursive: true, filter })`
 * DOES NOT OVERWRITE under Bun: with a `filter` it copies only files that are
 * missing at the destination and leaves existing ones untouched, while
 * reporting success. Without the filter the same call overwrites correctly.
 *
 * So from the day the test-file filter was added, every shared component under
 * `$lib/ext/` was frozen at whatever version happened to be committed. A fix
 * made in an extension's `studio/src/` synced cleanly, printed a ✓, and never
 * reached the Studio. That is a silent way to ship a vulnerability you believe
 * you have already fixed.
 *
 * The tests are skipped because they belong to the extensions repo and run
 * under `bun test` there; copied into the Studio tree, vitest and tsc both pick
 * them up and fail on `bun:test` — a green extension suite turning the Studio
 * red.
 */
function copyTreeSkippingTests(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTreeSkippingTests(src, dst);
      continue;
    }
    if (/\.(test|spec)\.(ts|js|svelte)$/.test(entry.name)) continue;
    copyFileSync(src, dst);
  }
}

/**
 * Extension pages the Studio deliberately does not carry.
 *
 * Each of these ships a page for a feature the core already provides, at a
 * different URL. Syncing them adds a second admin route for the same thing —
 * which is the mess a previous pass spent a day collapsing, after five
 * features had drifted into two divergent implementations apiece.
 *
 * They appear as untracked files after every sync, so the next person either
 * deletes them each time or, eventually, commits them. Named here instead,
 * with the core page each one duplicates, so the decision is visible rather
 * than rediscovered.
 *
 * Removing an entry is how you promote an extension's page over the core one —
 * delete the core route in the same change, or you are back to two.
 */
const SKIP_SLUGS = new Map<string, string>([
  ['byod', 'core (admin)/introspect — the nav links there, not here'],
  ['developer/edge-functions', 'core (admin)/edge-functions'],
  ['developer/views', 'core (admin)/views'],
  ['i18n', 'core (admin)/translations'],
]);

let synced = 0;
/** Destination slugs written this run — verified against biome ignores below. */
const syncedSlugs: string[] = [];
/** `$lib/ext/<name>` directories written this run. */
const syncedLibDirs: string[] = [];
/** Extensions with `studio/src/contribute.ts` copied this run (manifest.name keys). */
const syncedContributions: string[] = [];

for (const extRoot of EXT_ROOTS) {
  const extensions = findExtensions(extRoot);

  for (const extName of extensions) {
    const pagesDir = join(extRoot, extName, 'studio', 'pages');
    const srcDir = join(extRoot, extName, 'studio', 'src');
    const clientDir = join(extRoot, extName, 'client');
    const hasPages = existsSync(pagesDir);
    const hasSrc = existsSync(srcDir);
    const hasClient = existsSync(clientDir);
    // Schema-only pages delete studio/pages/, but field-type / shared components
    // still live under studio/src/ and must keep syncing into $lib/ext/.
    // `client/` counts too: an extension may ship only a block renderer.
    if (!hasPages && !hasSrc && !hasClient) continue;

    // The extension's `client/` → `$lib/ext/<name>/client/`.
    //
    // The Studio hosts authenticated surfaces — the intranet and the client
    // portal — and those draw PAGES, which since the pages merge means drawing
    // blocks. The renderer that knows how belongs to the extension, so the
    // Studio takes the same copy the public host does rather than growing a
    // second one. That is how the public renderer and the block library drifted
    // to sharing two block types out of twelve.
    //
    // Before the skip check on purpose: SKIP_SLUGS is about an admin PAGE
    // duplicating a core one, and says nothing about whether the extension's
    // block renderer is wanted. Putting this after it would drop the renderer
    // for any extension that ever lands on that list.
    if (hasClient) {
      const clientDest = join(LIB_EXT, extName, 'client');
      mkdirSync(clientDest, { recursive: true });
      copyTreeSkippingTests(clientDir, clientDest);
    }

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

    const skipReason = SKIP_SLUGS.get(slug);
    if (skipReason) {
      console.log(`[sync-ext] ·  ${extName} → ${slug}/ SKIPPED — duplicates ${skipReason}`);
      // Still sync studio/src for field components even when the admin page is skipped.
      if (hasSrc) {
        const libDest = join(LIB_EXT, extName);
        mkdirSync(libDest, { recursive: true });
        copyTreeSkippingTests(srcDir, libDest);
        syncedLibDirs.push(extName);
        if (existsSync(join(libDest, 'contribute.ts'))) {
          syncedContributions.push(extName);
        }
      }
      continue;
    }

    if (hasPages) {
      const dest = join(ROUTES_EXT, slug);
      mkdirSync(dest, { recursive: true });
      cpSync(pagesDir, dest, { recursive: true });
      syncedSlugs.push(slug);
      synced++;
      console.log(`[sync-ext] ✓  ${extName} → ${slug}/`);
    }

    // Copy studio/src/ (shared components, libs) → $lib/ext/<name>/ so pages and
    // field types can import via $lib/ext/<extName>/components/Foo.svelte.
    // Mirrors runtime studio-builder.ts; keeps dev parity with prod hot-install.
    if (hasSrc) {
      const libDest = join(LIB_EXT, extName);
      mkdirSync(libDest, { recursive: true });
      copyTreeSkippingTests(srcDir, libDest);
      syncedLibDirs.push(extName);
      if (existsSync(join(libDest, 'contribute.ts'))) {
        syncedContributions.push(extName);
      }
      if (!hasPages) console.log(`[sync-ext] ✓  ${extName} → $lib/ext/ (src only)`);
    }
  }
}

/** Regenerate the lazy-import registry for compile-time slot contributions. */
function writeContributionsRegistry(names: string[]): void {
  const sorted = [...names].sort();
  const entries =
    sorted.length === 0
      ? ''
      : sorted
          .map(
            (name) =>
              `  ${JSON.stringify(name)}: () => import(${JSON.stringify(`./${name}/contribute.js`)}),`,
          )
          .join('\n');
  const body = `// AUTO-GENERATED by scripts/sync-extensions.ts — do not edit.
// Re-run \`bun scripts/sync-extensions.ts\` after adding or removing studio/src/contribute.ts.

export const CONTRIBUTION_MODULES: Record<
  string,
  () => Promise<{ activate?: () => void }>
> = {
${entries}
};
`;
  mkdirSync(LIB_EXT, { recursive: true });
  Bun.write(join(LIB_EXT, '.contributions.generated.ts'), body);
  if (sorted.length > 0) {
    console.log(`[sync-ext] ✓  contributions registry → ${sorted.length} module(s)`);
  }
}

writeContributionsRegistry(syncedContributions);

/**
 * Remove what a PREVIOUS sync wrote and this one did not.
 *
 * Sync only ever added. When `content/page-builder` and `content/portals` merged
 * into `content/pages`, the admin route `(admin)/page-builder/` and the snapshot
 * `$lib/ext/content/page-builder/` stayed exactly where they were — so the Studio
 * kept a Page Builder screen whose every call went to
 * `/ext/content/page-builder/blocks`, an extension the engine no longer has. The
 * screen loaded and every button on it 404'd.
 *
 * The list of what to remove comes from a manifest this script writes, NOT from
 * "everything under (admin) that is not an extension". That distinction is the
 * whole safety argument: `(admin)/` also holds hand-written core routes, and a
 * prune that inferred generated-ness from the filesystem would delete them the
 * first time it was run somewhere the extensions repo was missing. Nothing is
 * ever removed that a previous run of this script did not create.
 */
const MANIFEST = join(LIB_EXT, '.synced.json');

interface SyncManifest {
  routes: string[];
  libs: string[];
  contributions: string[];
}

let previous: SyncManifest = { routes: [], libs: [], contributions: [] };
if (existsSync(MANIFEST)) {
  try {
    previous = JSON.parse(await Bun.file(MANIFEST).text()) as SyncManifest;
  } catch {
    // Unreadable manifest: prune nothing this run and rewrite it below. Deleting
    // on a guess is the one thing this must not do.
    previous = { routes: [], libs: [], contributions: [] };
  }
}

const wroteGeneratedTree =
  syncedSlugs.length > 0 || syncedLibDirs.length > 0 || syncedContributions.length > 0;

if (wroteGeneratedTree || existsSync(MANIFEST)) {
  const goneRoutes = previous.routes.filter((slug) => !syncedSlugs.includes(slug));
  const goneLibs = previous.libs.filter((name) => !syncedLibDirs.includes(name));

  for (const slug of goneRoutes) {
    const dir = join(ROUTES_EXT, slug);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    console.log(`[sync-ext] ✗  removed (admin)/${slug}/ — no extension claims it any more`);
  }
  for (const name of goneLibs) {
    const dir = join(LIB_EXT, name);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    console.log(`[sync-ext] ✗  removed $lib/ext/${name}/ — no extension claims it any more`);
  }

  mkdirSync(LIB_EXT, { recursive: true });
  await Bun.write(
    MANIFEST,
    `${JSON.stringify(
      {
        routes: syncedSlugs.sort(),
        libs: syncedLibDirs.sort(),
        contributions: syncedContributions.sort(),
      },
      null,
      2,
    )}\n`,
  );
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
if (wroteGeneratedTree) {
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
