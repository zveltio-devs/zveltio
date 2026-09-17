// packages/engine/src/lib/script-runner.ts
// Sandboxed script execution for flow `run_script` steps.
//
// SECURITY: AsyncFunction was removed because it runs in the same V8 context
// as the engine, giving user code access to globalThis, process.env, Bun.env,
// and all engine internals.
//
// This runs on the SUBPROCESS runner, not the in-process Worker, and the
// difference was measured rather than assumed:
//
//   A flow script that allocates without bound used to take the ENGINE down.
//   Not a 500, not a dead worker — `bun` exited 137, SIGKILL from the OOM
//   killer, with no error reported and nothing in the log. Every tenant on the
//   instance went with it. `run_script` is instance-admin-only, so this was
//   never a privilege-escalation path; it is the far more ordinary one where a
//   bad loop in a scheduled flow stops the product.
//
//   The Worker could not be capped: it is a thread in this process, Bun ignores
//   `resourceLimits` (measured — a worker capped at 64 MB allocated 4 GB and
//   reported success), and a host-side heap reading measures the engine rather
//   than the script, which is exactly the watchdog that was removed for killing
//   innocent invocations. A subprocess is capped by the kernel, so that is
//   where this belongs.
//
// The cost was measured too, because the number in the old comments was wrong
// in both directions. Per invocation, warmed, median of 15: Worker 31.8 ms,
// subprocess 42.6 ms. The documented "~1 ms vs ~30 ms" describes runner startup
// and not a real call — a flow step pays transpilation, compilation, lockdown
// and a round trip on every invocation either way. So the true price of this
// change is ~11 ms on a background executor, against an engine that can no
// longer be killed by a script.
//
// What the subprocess gives, all of which the Worker path lacked:
//   - a kernel memory ceiling (EDGE_MEMORY_LIMIT_MB, default 1024 MiB)
//   - a separate address space, hard-killable with SIGKILL
//   - a minimal environment: no DATABASE_URL, no BETTER_AUTH_SECRET
//   - refusal of `import()`, so the module loader is out of reach
//   - an SSRF guard that connects to the address it validated

import { runEdgeFunctionInSubprocess } from './edge-functions/subprocess-runner.js';
import type { EdgeRequest } from './edge-function-runner.js';

export interface ScriptResult {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  output: any;
  logs: string[];
  error?: string;
  duration_ms: number;
}

export async function runScript(
  code: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  input: Record<string, any> = {},
  timeoutMs = 30_000,
): Promise<ScriptResult> {
  const startTime = Date.now();

  // Wrap the script as the handler the subprocess protocol expects.
  //
  // `input` arrives as the request body rather than through `ctx.request.json()`
  // — the subprocess is handed a plain EdgeRequest, so there is no Request to
  // parse and no chance of the body going missing in serialisation.
  //
  // Nothing catches here on purpose. A script that throws makes the runner
  // answer `ok: false` with the message, which is what this function reports;
  // catching it locally would mean re-encoding an error that already has a
  // channel. Console output is captured by the runner itself.
  const wrappedCode = `
async function handler(request, env) {
  const input = request.body ?? {};
  const __output = await (async () => {
    ${code}
  })();
  return { status: 200, body: { output: __output ?? null } };
}
`;

  const request: EdgeRequest = {
    method: 'POST',
    headers: {},
    query: {},
    body: input,
    path: '/run-script',
  };

  try {
    const result = await runEdgeFunctionInSubprocess(wrappedCode, request, {}, timeoutMs);
    const logs = result.logs ?? [];

    if (!result.ok) {
      return {
        output: null,
        logs,
        error: result.error ?? 'Script failed without an error message',
        duration_ms: Date.now() - startTime,
      };
    }

    // The handler always returns `{ output }`; anything else means the protocol
    // changed under us, and the raw body is more useful than a null.
    const body = result.response?.body;
    const output =
      body && typeof body === 'object' && 'output' in body
        ? (body as { output: unknown }).output
        : (body ?? null);

    return { output, logs, duration_ms: Date.now() - startTime };
  } catch (error) {
    return {
      output: null,
      logs: [],
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startTime,
    };
  }
}
