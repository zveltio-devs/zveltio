#!/usr/bin/env bun
/**
 * Gate: `docs/private/` must not be tracked in a public repository.
 *
 * It was, from 2026-07-20 until the history rewrite of 2026-09-09 — 52 files
 * across 143 commits. No credentials were in them; the problem was the prose.
 * `CODE-REVIEW-STATE.md` records what each review session found AND what it
 * deliberately left open, in enough detail to act on. That is the right thing
 * to write down and the wrong thing to publish.
 *
 * `.gitignore` already covers the directory. This gate exists because an ignore
 * rule protects whoever has it: `git add -f`, a stale checkout that predates
 * the rule, a merge that resurrects the path, or a rewrite of `.gitignore`
 * itself all defeat it silently. The rewrite cost a force-push across 905 tags
 * and every open PR. Catching the first re-added file is cheaper than doing
 * that twice.
 *
 * It also checks the ignore rule itself, because a gate that only looks at the
 * index would pass a repository whose rule someone had removed — right up until
 * the next `git add`, which is exactly the state this is meant to prevent.
 *
 * The sibling extensions repository has the same exposure and the same rule.
 * Pass its path to check it too; CI checks each repository in its own job.
 *
 * Usage: bun scripts/check-private-docs-untracked.ts [repoRoot ...]
 */

import { $ } from 'bun';

const PROTECTED = 'docs/private/';

const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (roots.length === 0) roots.push('.');

let failed = false;

for (const root of roots) {
  const label = root === '.' ? 'this repository' : root;

  // Tracked files under the protected path. `ls-files` reports the index, which
  // is what a push would carry — not the working tree, where the files are
  // meant to stay.
  // `Bun.spawnSync` rather than the `$` shell: this repository's TypeScript
  // config does not see `$` as an export of `bun`, and every other gate here
  // spawns git the same way.
  const tracked = new TextDecoder()
    .decode(Bun.spawnSync(['git', '-C', root, 'ls-files', '--', PROTECTED]).stdout)
    .trim();

  if (tracked) {
    const files = tracked.split('\n').filter(Boolean);
    console.error(`\n❌ ${label}: ${files.length} file(s) tracked under ${PROTECTED}\n`);
    for (const f of files.slice(0, 20)) console.error(`   ${f}`);
    if (files.length > 20) console.error(`   … and ${files.length - 20} more`);
    console.error(
      `\n   These are working documents in a PUBLIC repository. Untrack them, keeping\n` +
        `   the files on disk:\n\n` +
        `     git -C ${root} rm -r --cached ${PROTECTED}\n\n` +
        `   If a document belongs in the open, move it out of ${PROTECTED} rather than\n` +
        `   weakening this gate — the directory is the signal.\n`,
    );
    failed = true;
    continue;
  }

  // The rule that keeps it that way. Checked through `check-ignore` rather than
  // by grepping `.gitignore`, so any mechanism counts: the repository's own
  // file, a parent's, or the global one.
  const probe = `${PROTECTED}__gate_probe__.md`;
  const ignored =
    Bun.spawnSync(['git', '-C', root, 'check-ignore', '-q', probe], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exitCode === 0;

  if (!ignored) {
    console.error(
      `\n❌ ${label}: nothing under ${PROTECTED} is tracked, but the path is not ignored.\n\n` +
        `   The next \`git add\` re-adds it. Restore the rule:\n\n` +
        `     echo '${PROTECTED}' >> ${root}/.gitignore\n`,
    );
    failed = true;
    continue;
  }

  console.log(`✅ ${label}: ${PROTECTED} is untracked and ignored.`);
}

process.exit(failed ? 1 : 0);
