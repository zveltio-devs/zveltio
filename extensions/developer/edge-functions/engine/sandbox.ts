/**
 * Edge function sandboxed executor
 *
 * Runs user code in an isolated Bun Worker thread so that infinite loops
 * or blocking operations cannot freeze the main Hono server process.
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
  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.text().catch(() => null)
    : null;

  const requestData = { url: request.url, method: request.method, headers, body };

  const worker = new Worker(new URL('./worker-runner.ts', import.meta.url), { type: 'module' });

  return new Promise<RunResult>((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({
        status: 504,
        body: '',
        logs: [],
        duration_ms: timeoutMs,
        error: `Function timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    worker.postMessage({ code, requestData, env });

    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
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
      clearTimeout(timer);
      worker.terminate();
      resolve({
        status: 500,
        body: '',
        logs: [],
        duration_ms: 0,
        error: e.message,
      });
    };
  });
}
