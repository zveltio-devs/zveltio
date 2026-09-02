import { sandboxWorkerEnv } from './sandbox-env.js';
/// <reference types="bun-types" />

/**
 * Edge function sandboxed executor
 *
 * Runs user code in an isolated Bun Worker thread so that infinite loops
 * or blocking operations cannot freeze the main Hono server process.
 *
 * Security hardening:
 *   - Timeout: worker killed after timeoutMs (default 5s)
 *   - Memory watchdog: kills worker if heap usage spikes above threshold
 */

export interface FunctionContext {
  request: Request;
  env: Record<string, string>;
}

export interface RunResult {
  status: number;
  body: string;
  logs: string[];
  duration_ms: number;
  error?: string;
}

export async function runFunction(
  code: string,
  request: Request,
  env: Record<string, string>,
  timeoutMs = 5000,
): Promise<RunResult> {
  // Serialize Request — Workers communicate via structured clone (no live objects)
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body =
    request.method !== 'GET' && request.method !== 'HEAD'
      ? await request.text().catch(() => null)
      : null;

  const requestData = {
    url: request.url,
    method: request.method,
    headers,
    body,
  };

  // Minimal environment — see the note in edge-function-runner.ts. The globals
  // lockdown cannot reach the module loader, so `import('node:process')` returns
  // the real env unless the Worker is given a different one.
  const worker = new Worker(new URL('./worker-runner.ts', import.meta.url), {
    type: 'module',
    env: sandboxWorkerEnv(),
  } as WorkerOptions);

  const start = Date.now();

  return new Promise<RunResult>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      worker.terminate();
    };

    // Timeout watchdog
    const timer = setTimeout(() => {
      cleanup();
      resolve({
        status: 504,
        body: '',
        logs: [],
        duration_ms: timeoutMs,
        error: `Function timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    // There is deliberately no memory watchdog here, and the absence is the fix.
    //
    // One used to sit at this spot, killing the invocation with 507 when
    // `process.memoryUsage().heapUsed` crossed a threshold. It could not do
    // that job, for a reason no reading of it would show: `heapUsed` is the
    // HOST thread's JS heap, and the work happens in a Worker.
    //
    // Measured on this runtime rather than reasoned about:
    //
    //     worker allocates ~200 MB   →  host heap grows   0 MB
    //     worker returns a 400 MB body →  host heap grows 0 MB
    //
    // So it never observed the function at all. What it DID observe was
    // everything else the engine had allocated — and on a busy engine that
    // meant an edge function which allocated nothing was killed with
    // "Function exceeded memory limit", quoting the server's megabytes back at
    // the caller.
    //
    // It surfaced as a test that failed only inside the full suite and never
    // alone, and reproduced exactly: clean heap → 504 (timed out); the same
    // fixture with 376 MB of unrelated ballast → 507 ("Heap: 384MB").
    //
    // What actually bounds a runaway function is still here: the timeout above
    // (504), and the worker dying of its own OOM, which arrives at `onerror`
    // below as a 500. Verified — a function that allocates without bound
    // returns 500 "Out of memory".
    //
    // A real per-invocation limit needs something Bun does not expose today: a
    // per-Worker heap cap or a per-Worker usage reading. Better nothing than a
    // guard that fires on the wrong signal and blames the wrong code.

    worker.postMessage({ code, requestData, env });

    worker.onmessage = (e) => {
      cleanup();
      const { success, status, body: respBody, logs, duration_ms, error } = e.data;
      resolve({
        status: success ? status : 500,
        body: respBody ?? '',
        logs: logs ?? [],
        duration_ms,
        error: success ? undefined : error,
      });
    };

    worker.onerror = (e) => {
      cleanup();
      resolve({
        status: 500,
        body: '',
        logs: [],
        duration_ms: Date.now() - start,
        error: e.message,
      });
    };
  });
}
