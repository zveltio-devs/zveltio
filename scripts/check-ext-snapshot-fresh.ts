#!/usr/bin/env bun
/**
 * Gate: the Studio's synced extension snapshot must equal its source.
 *
 * Two scripts copy out of the extensions repo, both wired as `prebuild`:
 *
 *   sync-extensions.ts        <ext>/studio/pages/ → studio  src/routes/(admin)/
 *                             <ext>/studio/src/   → studio  src/lib/ext/
 *                             <ext>/client/       → studio  src/lib/ext/<ext>/client/
 *   sync-extension-clients.ts <ext>/client/       → client  src/lib/ext/
 *
 * So every build overwrites all three trees from the extensions repo. The
 * committed copies are a snapshot, not a source.
 *
 * The client tree is easy to forget — `turbo build` builds client before studio
 * (studio depends on it), so a plain `bun run --cwd packages/studio build`
 * rewrites it too. A first version of this gate covered only the studio trees
 * and reported green while that build was changing files underneath it.
 *
 * Editing the snapshot therefore looks completely successful and changes
 * nothing that ships: the file is in git, review shows the fix, tests that
 * import `$lib/ext/...` read the edited version — and the next build replaces
 * it with the extensions-repo version. The change reaches master and never
 * reaches a user.
 *
 * This is not a hypothesis. It has now happened four times. The most recent
 * pass raised `text-base-content/40` to `/65` across the page builder to clear
 * the WCAG AA contrast floor, narrowed a set of `transition-all` rules, and
 * put the AI chat page's title through the i18n catalog. All of it was written
 * into the snapshot, all of it was committed, and a single `bun run build`
 * reverted every line — including a contrast fix, which is an accessibility
 * regression that no test would have reported.
 *
 * So: re-run the sync and require it to change nothing. A difference means the
 * edit went to the snapshot and belongs in `zveltio-extensions` instead.
 *
 * Refuses when the extensions repo is absent rather than skipping. A gate that
 * prints "skipping" is a gate that reports green for the one reason it exists.
 *
 * Usage: bun scripts/check-ext-snapshot-fresh.ts [path-to-zveltio-extensions]
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const STUDIO = join(ROOT, 'packages/studio');
const CLIENT = join(ROOT, 'packages/client');

/** The sync scripts to run, each in its own package. */
const SYNCS = [
  { cwd: STUDIO, script: 'scripts/sync-extensions.ts' },
  { cwd: CLIENT, script: 'scripts/sync-extension-clients.ts' },
];

/** Exactly the trees those two scripts write into. */
const SYNCED_TREES = [
  join(STUDIO, 'src/lib/ext'),
  join(STUDIO, 'src/routes/(admin)'),
  join(CLIENT, 'src/lib/ext'),
];

const extRoot =
  process.argv[2] ?? process.env.EXTENSIONS_DIR ?? join(ROOT, '..', 'zveltio-extensions');

if (!existsSync(extRoot)) {
  console.error(
    '❌ ext-snapshot-fresh: the extensions repo is not checked out.\n\n' +
      `   Looked for: ${extRoot}\n\n` +
      '   Without it the sync copies nothing and this gate would pass by\n' +
      '   default — which is the one outcome it must never produce. CI clones\n' +
      '   the sibling (paired branch, else master) before running the gates.\n',
  );
  process.exit(1);
}

/** filename → contents for every file under `dir`. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const rel of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
    out.set(rel, await Bun.file(join(dir, rel)).text());
  }
  return out;
}

const before = await Promise.all(SYNCED_TREES.map(snapshot));

// Preserve the working copy: the sync overwrites in place, and a developer may
// have uncommitted work in these trees that is not ours to discard.
const backup = mkdtempSync(join(tmpdir(), 'zv-ext-snapshot-'));
SYNCED_TREES.forEach((tree, i) => {
  if (existsSync(tree)) cpSync(tree, join(backup, String(i)), { recursive: true });
});

const differences: string[] = [];
try {
  for (const { cwd, script } of SYNCS) {
    const proc = Bun.spawnSync(['bun', script], {
      cwd,
      // SKIP_SYNC_EXT makes both scripts exit 0 having copied nothing, which
      // would turn this gate green for the reason it exists. Clear it.
      env: { ...process.env, EXTENSIONS_DIR: extRoot, SKIP_SYNC_EXT: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      console.error(
        `❌ ext-snapshot-fresh: ${script} itself failed (exit ${proc.exitCode}).\n\n` +
          new TextDecoder().decode(proc.stderr),
      );
      process.exit(1);
    }
  }

  const after = await Promise.all(SYNCED_TREES.map(snapshot));
  for (const [i, tree] of SYNCED_TREES.entries()) {
    const prefix = relative(ROOT, tree);
    for (const [rel, text] of after[i]) {
      const was = before[i].get(rel);
      if (was === undefined)
        differences.push(`  + ${prefix}/${rel}  (source has it, snapshot does not)`);
      else if (was !== text) differences.push(`  ~ ${prefix}/${rel}`);
    }
    for (const rel of before[i].keys()) {
      if (!after[i].has(rel))
        differences.push(`  - ${prefix}/${rel}  (snapshot has it, source does not)`);
    }
  }
} finally {
  SYNCED_TREES.forEach((tree, i) => {
    const saved = join(backup, String(i));
    if (!existsSync(saved)) return;
    rmSync(tree, { recursive: true, force: true });
    cpSync(saved, tree, { recursive: true });
  });
  rmSync(backup, { recursive: true, force: true });
}

if (differences.length > 0) {
  differences.sort();
  console.error(
    `❌ ext-snapshot-fresh: ${differences.length} file(s) differ from what the sync produces.\n\n` +
      `${differences.join('\n')}\n\n` +
      '   These are build outputs. Whatever is committed here, `prebuild` replaces\n' +
      '   it from the extensions repo — so a fix made in this tree is reviewed,\n' +
      '   merged, and then silently reverted before it ever reaches a user.\n\n' +
      `   The source of truth is ${extRoot}:\n` +
      '     studio src/lib/ext/<ext>/client/…  ← <ext>/client/…\n' +
      '     studio src/lib/ext/<ext>/…         ← <ext>/studio/src/…\n' +
      '     studio src/routes/(admin)/<slug>/… ← <ext>/studio/pages/…\n' +
      '     client src/lib/ext/<ext>/…         ← <ext>/client/…\n\n' +
      '   Move the change there, then re-run both syncs:\n' +
      '     bun run --cwd packages/studio sync-ext\n' +
      '     bun run --cwd packages/client sync:ext\n',
  );
  process.exit(1);
}

const counted = before.reduce((n, m) => n + m.size, 0);
console.log(`✅ ext-snapshot-fresh: ${counted} synced file(s) match the extensions repo exactly.`);
