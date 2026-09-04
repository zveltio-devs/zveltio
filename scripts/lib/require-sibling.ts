/**
 * A gate that scans the extensions repo must not report OK without it.
 *
 * This is the failure the 27–29 August audit found and the maturity plan opened
 * Block C for: `check-numeric-string-arithmetic` exited 0 in four distinct ways
 * that all read as "clean", and the CI job running it was the only one that did
 * not clone the sibling — so it was fed an empty corpus and said nothing was
 * wrong. Measured again on 2026-08-29, from a worktree with no sibling beside
 * it, six gates still did exactly that:
 *
 *   check-raw-sql-identifiers      OK — "every identifier is escaped", having
 *                                  never opened the repo its own header says it
 *                                  is scoped to on purpose
 *   check-atomic-writes            OK — 5 handlers, a fraction of the corpus
 *   check-duplicate-table-creators OK — 73 tables against 384 with the sibling
 *   check-fabricated-success       OK — 0 sites, scanning nothing
 *   check-insert-schema-match      SKIP, honest and still green
 *   check-extension-sdui-schemas   skip, likewise
 *
 * An absent corpus is not a clean corpus. Calling this turns "I checked and
 * found nothing" back into "I could not check".
 *
 * The opt-out is deliberate and narrow: a developer working in a checkout with
 * no sibling can set ZVELTIO_ALLOW_MISSING_SIBLING=1 and get a warning instead
 * of a refusal. CI never sets it — the jobs clone the sibling, and one that
 * forgets should go red rather than quiet.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Does this path hold the extensions repository, or merely exist?
 *
 * `existsSync` was the whole test, and an empty directory passes it. Measured:
 * with a sibling that exists and is empty, `check-fabricated-success` reported
 * "OK — 0 site(s), baseline allows 0" and exited 0, having scanned nothing —
 * the exact sentence this file's header says it exists to prevent, one step
 * further along. An absent corpus is not a clean corpus, and neither is an
 * empty one.
 *
 * Not hypothetical. An interrupted `git clone` leaves the directory behind, and
 * on 2026-09-04 `audit-gates.ts` was leaving empty directories inside the
 * sibling on every run.
 *
 * The marker is a manifest, because that is what makes the directory the
 * extensions repository rather than any other directory: every extension has
 * one, and a checkout that has none has nothing these gates read. Searched two
 * levels down, which covers `<category>/<ext>/manifest.json` and the
 * `<ext>/manifest.json` shape, and stops well short of a full walk.
 */
function looksLikeExtensionsRepo(root: string): boolean {
  const walk = (dir: string, depth: number): boolean => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'manifest.json') return true;
      if (depth > 0 && e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
        if (walk(join(dir, e.name), depth - 1)) return true;
      }
    }
    return false;
  };
  return walk(root, 2);
}

export function requireSibling(root: string, gate: string): void {
  if (existsSync(root) && looksLikeExtensionsRepo(root)) return;

  const empty = existsSync(root);

  if (process.env.ZVELTIO_ALLOW_MISSING_SIBLING === '1') {
    console.warn(
      `[${gate}] WARNING — ${empty ? 'the sibling checkout at ' + root + ' holds no extension manifest' : 'no sibling checkout at ' + root}; ` +
        'scanning this repository only, because ZVELTIO_ALLOW_MISSING_SIBLING=1.',
    );
    return;
  }

  console.error(
    `[${gate}] FAIL — ${empty ? `the sibling checkout at ${root} holds no extension manifest (an empty or half-cloned directory)` : `no sibling checkout at ${root}`}.\n` +
      '  This gate reads the extensions repository. Without it the corpus is empty or\n' +
      '  partial, and reporting OK would mean "found nothing" where the truth is "could\n' +
      '  not look". Clone it beside this one, or set ZVELTIO_ALLOW_MISSING_SIBLING=1 to\n' +
      '  scan this repository alone and accept the narrower answer.',
  );
  process.exit(1);
}
