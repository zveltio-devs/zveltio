#!/usr/bin/env bun
/**
 * Pre-build step for the worker isolation runtime.
 *
 * Bun's `--compile` mode does not auto-bundle workers instantiated
 * via `new Worker(new URL('./worker-runtime.ts', import.meta.url))`
 * even when the call site is statically reachable. The compiled
 * binary tries to resolve `/$bunfs/root/worker-extension-runtime.ts`
 * at runtime and fails with `BuildMessage: ModuleNotFound (entry
 * point)`. Verified live on alpha.118, .119, and .120.
 *
 * Workaround: compile `worker-extension-runtime.ts` here, ahead of
 * the engine compile, and emit the result as a TypeScript module
 * that exports the source as a string constant. At runtime the
 * host writes that string to a temp file and spawns the worker from
 * the temp path — Bun's worker constructor accepts an absolute disk
 * path and doesn't need build-time bundling.
 *
 * The generated file is committed (treated like the embedded.ts
 * migrations bundle) so cold checkouts work without a separate
 * codegen step, but the release workflow regenerates it before
 * compile so the bundled string is always fresh.
 */

import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src', 'lib', 'worker-extension-runtime.ts');
const OUT = join(__dirname, '..', 'src', 'lib', 'worker-extension-runtime-source.generated.ts');

const result = await Bun.build({
  entrypoints: [SRC],
  target: 'bun',
  format: 'esm',
  // Hono is a runtime dep of the worker shadow Hono; inline it so the
  // worker (running outside the engine's bundle) doesn't try to resolve
  // a bare specifier from the on-disk node_modules tree.
  external: [],
  minify: false,
});

if (!result.success) {
  const msgs = result.logs.map((l) => l.message).join('\n');
  console.error(`worker source bundle failed:\n${msgs}`);
  process.exit(1);
}

if (result.outputs.length === 0) {
  console.error('worker source bundle produced no output');
  process.exit(1);
}

const code = await result.outputs[0]!.text();

const fileContent = `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate via \`bun packages/engine/scripts/gen-worker-source.ts\`.
// Source: packages/engine/src/lib/worker-extension-runtime.ts
//
// See the script header for why this exists (Bun --compile worker
// bundling gap).

// biome-ignore lint/style/noNonNullAssertion: pre-validated by build
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this is a literal of source text

export const WORKER_RUNTIME_SOURCE = ${JSON.stringify(code)};
`;

writeFileSync(OUT, fileContent, 'utf8');
const kb = Math.round(code.length / 1024);
console.log(`✅ Emitted worker-extension-runtime-source.generated.ts (${kb} KB compiled source)`);
