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

// Worker bootstrap: sets up message handler, shadows dangerous globals via AsyncFunction params
const WORKER_BOOTSTRAP = `
'use strict';
self.onmessage = async (e) => {
  const { id, code, request, env, timeoutMs } = e.data;
  const logs = [];
  const _console = {
    log:   (...a) => logs.push(a.map(String).join(' ')),
    error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
    warn:  (...a) => logs.push('[warn] '  + a.map(String).join(' ')),
    info:  (...a) => logs.push('[info] '  + a.map(String).join(' ')),
  };
  try {
    // Shadow dangerous globals by naming them as params (shadows outer Worker scope)
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    const userFn = new AsyncFn(
      'request','env','console','fetch',
      'process','Bun','require','module','exports','globalThis','eval','Function','Worker','importScripts','self',
      '"use strict";\\n' + code +
      '\\nif (typeof handler !== "function") throw new Error("Edge function must define: async function handler(request, env)");' +
      '\\nreturn handler(request, env);'
    );
    const timeout = new Promise((_,rej) =>
      setTimeout(() => rej(new Error('Execution timed out after ' + timeoutMs + 'ms')), timeoutMs)
    );
    const raw = await Promise.race([
      userFn(request, env, _console, fetch,
        undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined),
      timeout,
    ]);
    let response;
    if (raw && typeof raw === 'object' && 'status' in raw) {
      response = { status: raw.status ?? 200, body: raw.body ?? null, headers: raw.headers ?? {} };
    } else {
      response = { status: 200, body: raw ?? null, headers: {} };
    }
    self.postMessage({ id, ok: true, response, logs });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message, logs });
  }
};
`;

export async function runEdgeFunction(
  code: string,
  request: EdgeRequest,
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<RunResult> {
  const start = Date.now();

  // Transpile TypeScript → JavaScript before sandboxing
  let jsCode: string;
  try {
    const transpiler = new (Bun as any).Transpiler({ loader: 'ts' });
    jsCode = transpiler.transformSync(code);
  } catch (err: any) {
    return { ok: false, error: `Transpile error: ${err.message}`, logs: [], duration_ms: Date.now() - start };
  }

  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const dataUrl = `data:application/javascript;base64,${btoa(unescape(encodeURIComponent(WORKER_BOOTSTRAP)))}`;
    const worker = new Worker(dataUrl);

    // Hard kill after timeoutMs + 2s — catches cases where the Worker itself hangs
    const hardKill = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: 'Worker hard timeout', logs: [], duration_ms: Date.now() - start });
    }, timeoutMs + 2000);

    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      clearTimeout(hardKill);
      worker.terminate();
      const duration_ms = Date.now() - start;
      if (e.data.ok) {
        resolve({ ok: true, response: e.data.response, logs: e.data.logs ?? [], duration_ms });
      } else {
        resolve({ ok: false, error: e.data.error, logs: e.data.logs ?? [], duration_ms });
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      clearTimeout(hardKill);
      worker.terminate();
      resolve({ ok: false, error: err.message, logs: [], duration_ms: Date.now() - start });
    };

    worker.postMessage({ id, code: jsCode, request, env: envVars, timeoutMs });
  });
}
