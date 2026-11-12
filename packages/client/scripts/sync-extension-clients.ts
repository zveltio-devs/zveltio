#!/usr/bin/env bun
/**
 * Copies `client/` from each extension into the reference host's source tree,
 * at `src/lib/ext/<extension>/`.
 *
 * WHY THIS EXISTS. The public block renderer lived here, in the host, while the
 * blocks it draws are defined by an extension. The two drifted until they shared
 * exactly two block types out of twelve: the builder wrote `hero`, `richtext`
 * and `collection_list`, and the host answered "Unsupported block" to all of
 * them, and neither side had a reason to notice. Measured, not inferred — a page
 * built from the full block library came out as ten placeholders.
 *
 * The owner's rule settles where the fix belongs: everything belonging to an
 * extension lives in the extension. So the renderer is the extension's, and the
 * host takes a copy — the same arrangement Studio already has for extension
 * pages (`packages/studio/scripts/sync-extensions.ts`), for the same reason.
 *
 * RELEASE-SAFE, and that is not decoration. With no sibling checkout and no
 * EXTENSIONS_DIR — which is every release build — this exits without writing,
 * so the COMMITTED snapshot survives. A script that overwrote it with nothing
 * would ship a host that renders no blocks at all, and that specific mistake has
 * been made three times in this repo.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

const CLIENT_ROOT = join(import.meta.dir, '..');

// Same resolution order as the Studio script.
const EXT_ROOTS = [
  // Dev: zveltio-extensions sits beside the monorepo.
  join(CLIENT_ROOT, '../../../zveltio-extensions'),
  // Production / CI: set by install.sh or the operator.
  process.env.EXTENSIONS_DIR ?? '',
]
  .filter(Boolean)
  .filter((p) => existsSync(p as string)) as string[];

const LIB_EXT = join(CLIENT_ROOT, 'src/lib/ext');

if (process.env.SKIP_SYNC_EXT === '1') {
  console.log('[sync-ext-client] SKIP_SYNC_EXT set — skipping.');
  process.exit(0);
}

if (EXT_ROOTS.length === 0) {
  console.log('[sync-ext-client] No extension directory found — keeping the committed snapshot.');
  process.exit(0);
}

/** `content/pages` — one level of nesting, matching the catalogue's names. */
function findExtensions(base: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(base)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(base, entry);
    if (!statSync(full).isDirectory()) continue;
    const name = prefix ? `${prefix}/${entry}` : entry;
    if (existsSync(join(full, 'manifest.json'))) out.push(name);
    else if (!prefix) out.push(...findExtensions(full, entry));
  }
  return out;
}

/**
 * Copy a directory, overwriting what is already there. Tests stay in the
 * extension; the host copy is what ships to a browser.
 *
 * Written out rather than `cpSync(..., { filter })`, which in Bun does NOT
 * overwrite existing files when a filter is passed — so a second run is a no-op
 * and the snapshot silently keeps serving the previous version. That trap froze
 * the Studio's `#lib/ext` for months, and it caught this script too: the first
 * sync wrote the files, the next one appeared to succeed and changed nothing,
 * and the renderer answered "Unsupported block: container" for a container it
 * had just been taught to draw.
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) {
      copyTree(src, dst);
    } else if (!/\.(test|spec)\.[tj]s$/.test(entry)) {
      copyFileSync(src, dst);
    }
  }
}

/**
 * What a PREVIOUS run wrote, so a file or an extension dropped upstream does not
 * survive as a stale copy in the host (same fix as the Studio's
 * `sync-extensions.ts`, #1654). Only names this script recorded are ever
 * removed; an unreadable list prunes nothing.
 */
const MANIFEST = join(LIB_EXT, '.synced.json');
let previous: string[] = [];
try {
  if (existsSync(MANIFEST)) previous = JSON.parse(await Bun.file(MANIFEST).text()) as string[];
} catch {
  previous = [];
}

const syncedNames = new Set<string>();
let synced = 0;
for (const extRoot of EXT_ROOTS) {
  for (const extName of findExtensions(extRoot)) {
    const clientDir = join(extRoot, extName, 'client');
    if (!existsSync(clientDir)) continue;

    const dest = join(LIB_EXT, extName);
    if (previous.includes(extName)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    copyTree(clientDir, dest);

    console.log(`[sync-ext-client] ✓  ${extName} → src/lib/ext/${extName}/`);
    syncedNames.add(extName);
    synced++;
  }
}

// Nothing synced (an empty or unrelated directory): keep the committed snapshot.
if (synced > 0) {
  for (const name of previous) {
    if (!syncedNames.has(name)) {
      rmSync(join(LIB_EXT, name), { recursive: true, force: true });
      console.log(`[sync-ext-client] ✗  ${name} removed (no longer shipped)`);
    }
  }
  writeFileSync(MANIFEST, JSON.stringify([...syncedNames].sort(), null, 2) + '\n');
}

console.log(`[sync-ext-client] Done — ${synced} extension client bundle(s) synced.`);
