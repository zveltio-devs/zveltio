#!/usr/bin/env bun
/**
 * Gate: the embedded worker runtime is the one in the repository.
 *
 * `bun --compile` does not bundle workers, so `worker-extension-runtime.ts` is
 * compiled ahead of time into a string constant in
 * `worker-extension-runtime-source.generated.ts`, which the host writes to a
 * temp file and spawns from. The generated file is committed so cold checkouts
 * work, and only `release.yml` regenerated it.
 *
 * That is the wrong way round. An edit to the runtime that nobody regenerated
 * meant CI ran its tests against the OLD embedded string while the release
 * shipped a freshly built NEW one — the program that was verified and the
 * program that ran were different. This is the same failure the extension
 * bundles had, where three security fixes were written, reviewed and merged
 * into TypeScript the runtime never loaded.
 *
 * Compares a HASH OF THE SOURCES rather than diffing the generated file: Bun's
 * bundler writes the entry path into a header comment, and that path depends on
 * the directory the build ran from, so a byte comparison fails on code nobody
 * touched. Measured before choosing — the naive version did exactly that.
 *
 * SOURCES, plural. This hashed the entry module alone, and the bundle inlines
 * seventeen files. `url-validator.ts` is one of them: #544 gave it the resolved
 * address that lets a caller close the DNS-rebinding race, nobody regenerated,
 * and the gate stayed green over a worker runtime still running the version
 * that returns nothing. The same shape as the extension bundles, where three
 * security fixes were merged into TypeScript the runtime never loaded.
 *
 * Usage: bun scripts/check-worker-source-fresh.ts
 */

import { join } from 'node:path';
import {
  hashWorkerSources,
  workerSourceSet,
} from '../packages/engine/scripts/lib/worker-source-set.js';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'packages/engine/src/lib/worker-extension-runtime.ts');
const GEN = join(ROOT, 'packages/engine/src/lib/worker-extension-runtime-source.generated.ts');

const { WORKER_RUNTIME_SOURCE, WORKER_RUNTIME_SOURCE_SHA256, WORKER_RUNTIME_BUNDLE_SHA256 } =
  (await import(GEN)) as {
    WORKER_RUNTIME_SOURCE?: string;
    WORKER_RUNTIME_SOURCE_SHA256?: string;
    WORKER_RUNTIME_BUNDLE_SHA256?: string;
  };

// The embedded string is the program the engine spawns. The source hash below
// cannot see it: a hand edit or a mangled merge of the generated file left that
// hash intact and this gate green over code no build produced. Measured — a
// `throw` rewritten inside the string passed.
const bundleActual = new Bun.CryptoHasher('sha256')
  .update(WORKER_RUNTIME_SOURCE ?? '')
  .digest('hex');
if (!WORKER_RUNTIME_BUNDLE_SHA256 || bundleActual !== WORKER_RUNTIME_BUNDLE_SHA256) {
  console.error(
    '❌ worker-source-fresh: the embedded worker runtime is not the bytes the\n' +
      '   generator emitted — the generated file was edited by hand, or carries\n' +
      '   no bundle hash yet.\n\n' +
      '   Regenerate it:  cd packages/engine && bun scripts/gen-worker-source.ts\n',
  );
  process.exit(1);
}

if (!WORKER_RUNTIME_SOURCE_SHA256) {
  console.error(
    '❌ worker-source-fresh: the generated file carries no source hash.\n\n' +
      '   Regenerate it:  cd packages/engine && bun scripts/gen-worker-source.ts\n',
  );
  process.exit(1);
}

const sources = workerSourceSet(SRC, ROOT);
const actual = hashWorkerSources(sources, ROOT);

if (actual !== WORKER_RUNTIME_SOURCE_SHA256) {
  console.error(
    '❌ worker-source-fresh: a source the worker runtime inlines changed and\n' +
      '   was not regenerated.\n\n' +
      `   sources hashed: ${sources.length} (the entry module and every local import)\n` +
      `   embedded: ${WORKER_RUNTIME_SOURCE_SHA256.slice(0, 16)}…\n` +
      `   on disk:  ${actual.slice(0, 16)}…\n\n` +
      '   The engine spawns workers from the EMBEDDED copy, so the edit does not\n' +
      '   run anywhere — tests included. Regenerate and commit:\n\n' +
      '     bun run format\n' +
      '     cd packages/engine && bun scripts/gen-worker-source.ts\n\n' +
      '   Format FIRST: it rewrites the source, so generating before formatting\n' +
      '   records a hash of a file that is about to change.\n',
  );
  process.exit(1);
}

console.log('✅ worker-source-fresh: the embedded worker runtime matches its source.');
