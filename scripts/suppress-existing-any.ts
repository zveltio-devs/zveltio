#!/usr/bin/env bun
/**
 * One-shot codemod: suppress every pre-existing `noExplicitAny` violation.
 *
 * Part of docs/HARDENING-9-PLAN.md item H-01. We flip `noExplicitAny` to
 * `error` in `biome.json`, but the codebase already has ~800 legacy `any`
 * escapes. Failing the whole build on day one is not the goal — the goal is a
 * RATCHET: freeze the existing violations behind explicit suppression comments,
 * then forbid new ones (any fresh `any` fails lint) and let the count only ever
 * drop. This script writes those freezing comments.
 *
 * It does NOT hand-roll an AST codemod. Biome's own `--suppress` inserts a
 * correct `// biome-ignore lint/suspicious/noExplicitAny: <reason>` line above
 * each violation, in the right place, for `.ts`/`.tsx` AND `.svelte` script
 * blocks. We just feed it the exact non-test file set (see `lib/any-targets.ts`)
 * because `--only` overrides the tests-are-off config override and would
 * otherwise suppress inside test files too.
 *
 * Run once, review the diff, commit. Re-running is safe (already-suppressed
 * violations are left alone) but should be a no-op on a clean tree.
 *
 * Usage:
 *   bun run scripts/suppress-existing-any.ts          # apply
 *   bun run scripts/suppress-existing-any.ts --dry     # list target count only
 */

import { enumerateTargets } from './lib/any-targets.ts';

const REASON = 'legacy any; tracked in docs/HARDENING-9-PLAN.md H-01';
const BATCH = 150; // keep argv under the Windows ~32k command-line limit

const dry = process.argv.includes('--dry');
const targets = enumerateTargets();

console.log(`[suppress-any] ${targets.length} in-scope files (non-test, non-generated).`);
if (dry) {
  process.exit(0);
}

let failed = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  const proc = Bun.spawnSync(
    [
      'bunx',
      'biome',
      'lint',
      '--suppress',
      `--reason=${REASON}`,
      '--only=suspicious/noExplicitAny',
      ...batch,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  // Biome exits non-zero when it still reports diagnostics it could not fix;
  // for --suppress that should not happen, but surface it if it does.
  if (proc.exitCode !== 0) {
    const err = proc.stderr.toString();
    // "Fixed N files" on stdout is success even with a non-zero code in some
    // biome versions; only treat genuine errors as failures.
    if (/error\b/i.test(err) && !/Fixed \d+ file/.test(proc.stdout.toString())) {
      console.error(`[suppress-any] batch ${i / BATCH} failed:\n${err}`);
      failed++;
    }
  }
  console.log(`[suppress-any] processed ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
}

if (failed > 0) {
  console.error(`[suppress-any] ${failed} batch(es) reported errors — inspect above.`);
  process.exit(1);
}
console.log('[suppress-any] done. Review `git diff`, then run `bun run format` and commit.');
