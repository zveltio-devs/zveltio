#!/usr/bin/env bun
/**
 * Gate: an edge function runs inside the COMPILED BINARY.
 *
 * The binary is what ships — `Dockerfile` ends `ENTRYPOINT
 * ["/usr/local/bin/zveltio"]` — and it is its own interpreter. `process.execPath`
 * is the engine, not `bun`, so the runner's `<execPath> run <bootstrap.mjs>`
 * re-executed the ENGINE with two arguments and the bootstrap never ran.
 *
 * Measured in a real binary before the repair:
 *
 *   execPath = /tmp/binprobe
 *   edge fn  => { ok: false, error: "Killed by SIGKILL — …" }
 *
 * Nothing caught it. Typecheck cannot: the code is correct. The unit suite
 * cannot: `bun test` is not a binary. The release smoke test boots the binary
 * and checks health and marketplace, but never invokes a function. And once the
 * in-process Worker mode was deleted there was no second runner left to mask it,
 * so this had become "edge functions do not work in any container".
 *
 * So the gate does two things. It compiles a probe that reaches the runner the
 * way the entry point does and asks it for the one thing only a binary can
 * answer — that proves the MECHANISM. Then it checks that every place which
 * actually compiles a binary names `binary-entry.ts` — that proves the
 * mechanism is REACHED.
 *
 * The other two halves exist because a gate that builds its own subject can
 * only ever prove the subject it built, and both mistakes it could not see have
 * now shipped:
 *
 *   - `release.yml` built from `index.ts`, so every published binary asset
 *     answered `zveltio: unknown command "__edge-runner"` and failed every
 *     invocation. The hand-written probe answers the sentinel regardless.
 *   - `binary-entry.ts` reached `index.ts` through a DYNAMIC import, which put
 *     its own graph ahead of `reflect-metadata`; the compiled binary then
 *     answered EVERY command with `tsyringe requires a reflect polyfill`. The
 *     Docker image of v3.0.0-beta.65 could not start at all.
 *
 * So: check the build sites, compile the real entry point and ask it to be both
 * of the things it has to be, and only then run the mechanism through a probe.
 *
 * ~15 seconds, which is the price of knowing.
 */

import { spawn } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EDGE_RUNNER_SENTINEL } from '../packages/engine/src/lib/edge-functions/runner-sentinel.js';

const ENGINE = join(import.meta.dir, '..', 'packages', 'engine');
const work = mkdtempSync(join(tmpdir(), 'zveltio-binary-gate-'));
const binary = join(work, 'zveltio-probe');

function fail(message: string, detail?: string): never {
  console.error(`✗ binary-edge-function: ${message}`);
  if (detail) console.error(detail.split('\n').slice(0, 12).join('\n'));
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// ── Half one: every build site compiles `binary-entry.ts` ──────────────────
//
// A build site that names `index.ts` produces a binary which answers
// `unknown command "__edge-runner"`, and the probe below cannot see it.
const BUILD_SITES = [
  'Dockerfile',
  '.github/workflows/release.yml',
  'packages/engine/scripts/build-binary.ts',
  'packages/cli/src/commands/deploy.ts',
];
const ROOT = join(import.meta.dir, '..');
//
// Checked on the `bun build` invocation, not on the file's text: the first
// version of this looked for the string `binary-entry.ts` anywhere in the
// file, and the comment explaining the rule satisfied it — the defect was put
// back and the gate stayed green.
const BUILDS_AN_INDEX = /bun build\s+\S*index\.ts/;
for (const site of BUILD_SITES) {
  const text = await Bun.file(join(ROOT, site)).text();
  const badBuild = BUILDS_AN_INDEX.exec(text);
  if (badBuild) {
    fail(
      `${site} compiles a binary from an index.ts: \`${badBuild[0]}\``,
      'A binary built from index.ts cannot be an edge-function runner: it\n' +
        'answers `unknown command "__edge-runner"` and every edge function fails.',
    );
  }
  if (!text.includes('binary-entry.ts')) {
    fail(
      `${site} compiles a binary but never names binary-entry.ts`,
      'A binary built from index.ts cannot be an edge-function runner: it\n' +
        'answers `unknown command "__edge-runner"` and every edge function fails.',
    );
  }
}

// ── Half two: the REAL entry point compiles and can still be an engine ─────
//
// The probe below is hand-written, so it cannot see a mistake in
// `binary-entry.ts` itself. One shipped: reaching `index.ts` through a DYNAMIC
// import put this file's graph ahead of it, `reflect-metadata` no longer loaded
// first, and the binary answered every command with `tsyringe requires a
// reflect polyfill`. The Docker image of v3.0.0-beta.65 could not start.
//
// So compile the actual entry point and ask it for both of its jobs: be an
// engine (`help` exits 0) and be a runner (the sentinel imports a module).
const realBinary = join(work, 'zveltio-entry');
const entryBuild = spawn({
  cmd: [
    'bun',
    'build',
    join(ENGINE, 'src/binary-entry.ts'),
    '--compile',
    `--outfile=${realBinary}`,
  ],
  stdout: 'pipe',
  stderr: 'pipe',
  cwd: ENGINE,
});
const entryBuildErr = await new Response(entryBuild.stderr).text();
await entryBuild.exited;
if (entryBuild.exitCode !== 0) fail('binary-entry.ts did not compile', entryBuildErr);

const help = spawn({ cmd: [realBinary, 'help'], stdout: 'pipe', stderr: 'pipe' });
const [helpOut, helpErr] = await Promise.all([
  new Response(help.stdout).text(),
  new Response(help.stderr).text(),
]);
await help.exited;
if (help.exitCode !== 0) {
  fail(
    `the compiled entry point cannot run a command (exit ${help.exitCode})`,
    `${helpOut}\n${helpErr}`,
  );
}

const bootstrapProbe = join(work, 'bootstrap-probe.mjs');
writeFileSync(bootstrapProbe, "console.log('BOOTSTRAP-RAN');\n");
const sentinel = spawn({
  cmd: [realBinary, EDGE_RUNNER_SENTINEL, bootstrapProbe],
  stdout: 'pipe',
  stderr: 'pipe',
});
const [sentinelOut, sentinelErr] = await Promise.all([
  new Response(sentinel.stdout).text(),
  new Response(sentinel.stderr).text(),
]);
await sentinel.exited;
if (!sentinelOut.includes('BOOTSTRAP-RAN')) {
  fail(
    'the compiled entry point did not run the bootstrap it was handed',
    `${sentinelOut}\n${sentinelErr}`,
  );
}

// ── Half three: the mechanism itself, inside a real compiled binary ─────────
// A probe that reaches the runner the way the entry point does — so a runner
// that stops answering the sentinel fails here.
const probe = join(work, 'probe.ts');
writeFileSync(
  probe,
  `import { EDGE_RUNNER_SENTINEL } from ${JSON.stringify(join(ENGINE, 'src/lib/edge-functions/runner-sentinel.ts'))};
if (process.argv[2] === EDGE_RUNNER_SENTINEL) {
  await import(process.argv[3]!);
} else {
  const { runEdgeFunctionInSubprocess } = await import(
    ${JSON.stringify(join(ENGINE, 'src/lib/edge-functions/subprocess-runner.ts'))}
  );
  const res = await runEdgeFunctionInSubprocess(
    'async function handler(request, env) { return { status: 201, body: { sum: 1 + 1, who: env.WHO } }; }',
    { method: 'POST', headers: {}, query: {}, body: { a: 1 }, path: '/probe' },
    { WHO: 'binary' },
    15000,
  );
  console.log(JSON.stringify(res));
}
`,
);

const build = spawn({
  cmd: ['bun', 'build', probe, '--compile', '--outfile', binary],
  stdout: 'pipe',
  stderr: 'pipe',
  cwd: ENGINE,
});
const buildErr = await new Response(build.stderr).text();
await build.exited;
if (build.exitCode !== 0) fail('the probe did not compile', buildErr);

const run = spawn({ cmd: [binary], stdout: 'pipe', stderr: 'pipe' });
const killer = setTimeout(() => run.kill('SIGKILL'), 60_000);
const [out, err] = await Promise.all([
  new Response(run.stdout).text(),
  new Response(run.stderr).text(),
]);
await run.exited;
clearTimeout(killer);

if (run.exitCode !== 0) {
  fail(`the binary exited with ${run.exitCode}`, `${out}\n${err}`);
}

let result: { ok?: boolean; response?: { status?: number; body?: unknown }; error?: string };
try {
  result = JSON.parse(out.trim().split('\n').at(-1) ?? '');
} catch {
  fail('the binary printed no result', `${out}\n${err}`);
}

if (!result.ok) {
  fail(
    'an edge function did not run inside the compiled binary',
    `error: ${result.error}\n\nThe binary is its own interpreter: spawning it with \`run <file>\`\nre-executes the engine instead of running the bootstrap. The entry point\n(packages/engine/src/binary-entry.ts) has to answer the runner sentinel.`,
  );
}
if (result.response?.status !== 201) {
  fail(`the handler answered ${result.response?.status}, expected 201`, out);
}

rmSync(work, { recursive: true, force: true });
console.log('✅ binary-edge-function: an edge function runs inside the compiled binary.');
