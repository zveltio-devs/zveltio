/**
 * The compiled binary's entry point.
 *
 * A compiled Bun binary is its own interpreter: `process.execPath` is
 * `/usr/local/bin/zveltio`, not `bun`. The edge-function runner spawns
 * `<execPath> run <bootstrap.mjs>` — which in a binary re-executes the ENGINE
 * with the arguments `run` and a path, rather than running the bootstrap. So
 * edge functions did not work in any container deployment, and after the
 * in-process Worker mode was removed there was nothing left to fall back to.
 *
 * Measured before this file existed, in a real compiled binary:
 *
 *   execPath = /tmp/binprobe
 *   edge fn  => { ok: false, error: "Killed by SIGKILL — …" }
 *
 * This dispatches on the sentinel BEFORE importing the app. It has to be a
 * separate entry point rather than a check at the top of `index.ts`, because ESM
 * runs every import for its side effects before the first statement of the
 * module — the child would boot a second engine, database pool included, on its
 * way to deciding not to be one.
 *
 * Verified in a compiled binary: the sentinel path imports a `.mjs` written to a
 * temp directory and the bootstrap runs, static `node:dns/promises` import and
 * all.
 */

import { EDGE_RUNNER_SENTINEL } from './lib/edge-functions/runner-sentinel.js';

if (process.argv[2] === EDGE_RUNNER_SENTINEL) {
  const bootstrap = process.argv[3];
  if (!bootstrap) {
    console.error(`${EDGE_RUNNER_SENTINEL} needs the path of a bootstrap module`);
    process.exit(2);
  }
  // The same generated bootstrap the non-compiled runner executes with
  // `bun run` — one implementation, two ways of reaching it.
  await import(bootstrap);
} else {
  // `reflect-metadata` before the app, and as its own statement: `index.ts`
  // imports it first for exactly this reason, but reaching `index.ts` through a
  // DYNAMIC import puts this file's own graph ahead of it in the bundle's load
  // order, and tsyringe — pulled in transitively by @better-auth/passkey —
  // initialises decorators at module load. Measured in a compiled binary built
  // from this file before the import existed:
  //
  //   $ ./zveltio help
  //   error: tsyringe requires a reflect polyfill. Please add
  //          'import "reflect-metadata"' to the top of your entry point.
  //
  // i.e. the binary could not run ANY command. It is imported here rather than
  // at the top of the file so the runner branch above does not pay for it.
  await import('reflect-metadata');
  await import('./index.js');
}
