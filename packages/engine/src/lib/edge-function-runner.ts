export interface EdgeRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  path: string;
}

export interface EdgeResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface RunResult {
  ok: boolean;
  response?: EdgeResponse;
  error?: string;
  logs: string[];
  duration_ms: number;
}

/**
 * Run an edge function.
 *
 * One runner: a fresh Bun process per invocation, with a minimal environment
 * (no DATABASE_URL, no BETTER_AUTH_SECRET), a kernel memory ceiling, a refusal
 * of `import()`, and an SSRF guard that connects to the address it validated.
 *
 * There used to be a second, `EDGE_SANDBOX_MODE=worker`, an in-process Worker
 * thread kept for latency. Every property that justified it failed measurement:
 *
 *   - it was not faster in the way that mattered. Per invocation, warmed,
 *     median of 15: worker 31.8 ms, subprocess 42.6 ms — and a pre-spawned
 *     subprocess answers in 13.4 ms, so the in-process runner was not even the
 *     fast option, only the unbounded one.
 *   - it could not be given a memory ceiling. Bun ignores a Worker's
 *     `resourceLimits` (one capped at 64 MB allocated 4 GB and reported
 *     success); `smol` and `BUN_JSC_forceRAMSize` are garbage-collector
 *     settings, not limits; a host-side heap reading measures the engine rather
 *     than the function, which is why the watchdog that used to live here was
 *     removed for killing invocations that had allocated nothing.
 *   - the only remaining way to bound it was `worker.terminate()`, and Bun's
 *     own documentation calls the Worker API "still experimental (particularly
 *     for terminating workers)".
 *
 * `EDGE_SANDBOX_MODE` is ignored. It is read nowhere, so an operator who still
 * has it set gets the safe runner rather than a silent downgrade.
 */
export async function runEdgeFunction(
  code: string,
  request: EdgeRequest,
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<RunResult> {
  const { runEdgeFunctionInSubprocess } = await import('./edge-functions/subprocess-runner.js');
  return runEdgeFunctionInSubprocess(code, request, envVars, timeoutMs);
}
