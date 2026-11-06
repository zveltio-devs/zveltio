/**
 * Isolation probe for Deno jobs on the runner (ADR 0023 decision 2). Plays the
 * engine: gets Deno as the engine does (`ensureDeno`, downloading it into the
 * extensions directory the runner shares), then runs one job through
 * `runInDeno` over whichever transport ZVELTIO_EXT_TRANSPORT selects. Its
 * `fetch` goes through the engine's egress bridge, held to PROBE_EGRESS.
 *
 *   PROBE_JOB=hold  (default) the job waits PROBE_HOLD_MS, then fetches PROBE_URL
 *   PROBE_JOB=alloc the job allocates past its memoryMb (64)
 *
 * Prints one JSON line: { transport, result | error }.
 *
 * Nothing about the boundary is read from inside the job: Deno's permissions
 * refuse it everything, and the uid and the seccomp filter are what must hold
 * when they fail. So the calling script finds the job's process while it is
 * held and reads its uid and `Seccomp:` from /proc, and tries the engine's
 * secrets under that uid. Run by ext-runner-{standalone,compose,systemd}.sh;
 * on its own it proves nothing.
 */

import { parseRequest, performEgress } from '../src/lib/edge-functions/egress.js';
import { ensureDeno } from '../src/lib/extensions/deno.js';
import { jobPlacement, runInDeno } from '../src/lib/extensions/job-runner.js';

const JOBS = `export default {
  hold: async (input, host) => {
    await new Promise((r) => setTimeout(r, input.holdMs));
    let fetched = 'skipped';
    if (input.url) {
      try { fetched = 'HTTP ' + (await host.fetch(input.url)).status; }
      catch (e) { fetched = 'DENIED ' + e.message; }
    }
    await host.collections.insert('result', { fetch: fetched });
  },
  alloc: async () => {
    const a = [];
    for (let i = 0; i < 64; i++) a.push(new Uint8Array(32 << 20).fill(1));
  },
};`;

const egress = (process.env.PROBE_EGRESS ?? '').split(/[\s,]+/).filter(Boolean);
let result: unknown = null;
const deno = await ensureDeno();
try {
  await runInDeno({
    extName: process.env.PROBE_EXT ?? 'acme/job-probe',
    deno,
    code: new TextEncoder().encode(JOBS),
    job: process.env.PROBE_JOB ?? 'hold',
    input: { holdMs: Number(process.env.PROBE_HOLD_MS ?? 0), url: process.env.PROBE_URL ?? '' },
    timezone: 'UTC',
    memoryMb: 64,
    timeoutSeconds: 60,
    call: async (name, args) => {
      if (name === 'collections.insert') {
        result = args[1];
        return null;
      }
      if (name !== 'fetch') throw new Error(`${name}: not in this probe`);
      // As jobs.ts `jobFetch`: the engine's bridge, with the job runner's pinning.
      const req = parseRequest(JSON.stringify({ ...(args[0] as object), id: 0 }));
      if (!req) throw new Error('fetch: malformed request');
      const a = await performEgress(req, egress, AbortSignal.timeout(10_000), true);
      if (!a.ok) throw new Error(a.error);
      const { id: _, ...answer } = a;
      return answer;
    },
  });
  console.log(JSON.stringify({ transport: jobPlacement(), result }));
} catch (err) {
  console.log(JSON.stringify({ transport: jobPlacement(), error: (err as Error).message }));
}
process.exit(0);
