/**
 * Isolation probe for edge functions on the runner (RFC extension-runner,
 * step 5). Plays the engine: runs one edge function through
 * `runEdgeFunctionInSubprocess`, as the edge route does, over whichever
 * transport ZVELTIO_EDGE_TRANSPORT selects. The function tries to read the
 * engine's `.env` and this process's environment, and to reach PROBE_URL.
 * Prints one JSON line: { transport, env, environ, fetch, uid }.
 *
 *   bun scripts/edge-runner-isolation.ts <env path>
 *
 * Files are read through `global.fetch('file://…')`: `global` is missing from
 * the sandbox's blocklist, so it reaches the unguarded fetch — an escape from
 * the JS lockdown that exists today, which is exactly what the uid boundary is
 * for. If the lockdown closes it, the `process` run stops reading the secret
 * and the scripts fail loudly ("probe broken?"); the probe then needs another
 * way out of the sandbox, not a weaker assertion.
 *
 * Run by ext-runner-compose.sh and ext-runner-systemd.sh; on its own it proves
 * nothing.
 */

import {
  drainRunnerPool,
  runEdgeFunctionInSubprocess,
} from '../src/lib/edge-functions/subprocess-runner.js';

const envPath = process.argv[2];
if (!envPath) {
  console.error('usage: edge-runner-isolation.ts <env path>');
  process.exit(2);
}

const code = `async function handler(request, env) {
  const denied = (e) => 'DENIED ' + (e.code ?? e.name ?? e.message);
  const read = async (p) => {
    try { return await (await global.fetch('file://' + p)).text(); } catch (e) { return denied(e); }
  };
  let fetched = 'skipped';
  if (env.url) {
    try { fetched = 'HTTP ' + (await fetch(env.url, { signal: AbortSignal.timeout(3000) })).status; }
    catch (e) { fetched = denied(e); }
  }
  return {
    env: await read(env.envPath),
    environ: await read('/proc/' + env.pid + '/environ'),
    fetch: fetched,
    uid: Number.parseInt((await read('/proc/self/status')).split('Uid:')[1] ?? ''),
  };
}`;

const res = await runEdgeFunctionInSubprocess(
  code,
  { method: 'GET', headers: {}, query: {}, body: null, path: '/' },
  { envPath, pid: String(process.pid), url: process.env.PROBE_URL ?? '' },
  10_000,
);
await drainRunnerPool();
if (!res.ok) {
  console.error(`probe: ${res.error} ${JSON.stringify(res.logs)}`);
  process.exit(1);
}
// The variable, not edgeTransport(): run against an engine that predates the
// runner, the probe must still answer — and show what it reaches there.
const transport = process.env.ZVELTIO_EDGE_TRANSPORT === 'runner' ? 'runner' : 'process';
console.log(JSON.stringify({ transport, ...(res.response?.body as object) }));
process.exit(0);
