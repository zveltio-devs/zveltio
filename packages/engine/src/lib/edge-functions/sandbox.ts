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

const WORKER_MEMORY_LIMIT = 64 * 1024 * 1024; // 64 MB per worker
const MEMORY_CHECK_INTERVAL = 50; // ms between heap checks

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

  const worker = new Worker(new URL('./worker-runner.ts', import.meta.url), {
    type: 'module',
  });

  const start = Date.now();

  return new Promise<RunResult>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(memCheck);
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

    // Memory watchdog — kills worker if heap spikes above safety threshold
    const memCheck = setInterval(() => {
      if (resolved) return; // Prevent multiple cleanup calls
      try {
        const usage = process.memoryUsage();
        if (usage.heapUsed > WORKER_MEMORY_LIMIT * 4) {
          // Safety threshold: if total heap > 4× worker limit, kill to protect server
          cleanup();
          resolve({
            status: 507,
            body: '',
            logs: [],
            duration_ms: Date.now() - start,
            error: `Function exceeded memory limit. Heap: ${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
          });
        }
      } catch {
        // process.memoryUsage() unavailable — skip check
      }
    }, MEMORY_CHECK_INTERVAL);

    worker.postMessage({ code, requestData, env });

    worker.onmessage = (e) => {
      cleanup();
      const {
        success,
        status,
        body: respBody,
        logs,
        duration_ms,
        error,
      } = e.data;
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
