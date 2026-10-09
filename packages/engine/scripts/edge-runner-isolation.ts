/**
 * Isolation probe for edge functions on the runner (RFC extension-runner,
 * step 5). Plays the engine: runs one edge function through
 * `runEdgeFunctionInSubprocess`, as the edge route does, over whichever
 * transport ZVELTIO_EDGE_TRANSPORT selects. The function stays alive for
 * PROBE_HOLD_MS, then tries to reach PROBE_URL through the sandboxed fetch.
 * Prints one JSON line: { transport, fetch }.
 *
 *   bun scripts/edge-runner-isolation.ts
 *
 * Nothing is read from inside the function: the JS lockdown leaves no way to
 * the filesystem or the process (#1002), and the uid boundary is what has to
 * hold when that lockdown fails. So the calling script measures it from the
 * outside while the function is held: it finds the invocation's process, takes
 * its uid, and tries the engine's secrets under that uid.
 *
 * Run by ext-runner-compose.sh and ext-runner-systemd.sh; on its own it proves
 * nothing.
 */

import {
  drainRunnerPool,
  runEdgeFunctionInSubprocess,
} from '../src/lib/edge-functions/subprocess-runner.js';

const holdMs = Number(process.env.PROBE_HOLD_MS ?? 0);

const code = `async function handler(request, env) {
  await new Promise((r) => setTimeout(r, Number(env.holdMs)));
  let fetched = 'skipped';
  if (env.url) {
    try { fetched = 'HTTP ' + (await fetch(env.url, { signal: AbortSignal.timeout(3000) })).status; }
    catch (e) { fetched = 'DENIED ' + (e.code ?? e.name ?? e.message); }
  }
  return { fetch: fetched };
}`;

const res = await runEdgeFunctionInSubprocess(
  code,
  { method: 'GET', headers: {}, query: {}, body: null, path: '/' },
  { url: process.env.PROBE_URL ?? '', holdMs: String(holdMs) },
  holdMs + 10_000,
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
