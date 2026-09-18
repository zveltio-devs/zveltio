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
 * So the gate compiles the real entry point and asks it for the one thing only a
 * binary can answer. ~5 seconds, which is the price of knowing.
 */

import { spawn } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENGINE = join(import.meta.dir, '..', 'packages', 'engine');
const work = mkdtempSync(join(tmpdir(), 'zveltio-binary-gate-'));
const binary = join(work, 'zveltio-probe');

function fail(message: string, detail?: string): never {
  console.error(`✗ binary-edge-function: ${message}`);
  if (detail) console.error(detail.split('\n').slice(0, 12).join('\n'));
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// A probe that exercises the runner through the SAME entry point the release
// builds — so an entry point that forgets to answer the sentinel fails here.
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
