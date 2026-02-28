/**
 * Edge function worker runner — executes user code in an isolated Bun Worker thread.
 * This file runs in a separate thread, preventing infinite loops from freezing the server.
 */

interface WorkerPayload {
  code: string;
  requestData: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
  env: Record<string, string>;
}

const STDLIB = `
const _logs = [];
const console = {
  log: (...args) => _logs.push('[log] ' + args.join(' ')),
  error: (...args) => _logs.push('[err] ' + args.join(' ')),
  warn: (...args) => _logs.push('[warn] ' + args.join(' ')),
};
`;

self.onmessage = async (e: MessageEvent<WorkerPayload>) => {
  const { code, requestData, env } = e.data;
  const logs: string[] = [];
  const start = Date.now();

  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const js = transpiler.transformSync(`${STDLIB}\n${code}`);

    const safeGlobals: Record<string, any> = {
      fetch,
      Request,
      Response,
      URL,
      URLSearchParams,
      Headers,
      crypto,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      _logs: logs,
      console: {
        log: (...args: any[]) => logs.push(`[log] ${args.join(' ')}`),
        error: (...args: any[]) => logs.push(`[err] ${args.join(' ')}`),
        warn: (...args: any[]) => logs.push(`[warn] ${args.join(' ')}`),
      },
    };

    const fn = new Function(
      ...Object.keys(safeGlobals),
      `${js}; return typeof handler !== 'undefined' ? handler : (typeof module !== 'undefined' ? module.exports?.default : null);`,
    );

    const handler = fn(...Object.values(safeGlobals));

    if (typeof handler !== 'function') {
      self.postMessage({
        success: false,
        error: 'Function must export a default handler',
        logs,
        duration_ms: Date.now() - start,
        status: 500,
        body: '',
      });
      return;
    }

    const request = new Request(requestData.url, {
      method: requestData.method,
      headers: new Headers(requestData.headers),
      body: requestData.body ?? undefined,
    });

    const ctx = { request, env };
    const result: Response = await handler(ctx);
    const body = await result.text();

    self.postMessage({
      success: true,
      status: result.status,
      body,
      logs,
      duration_ms: Date.now() - start,
    });
  } catch (err: any) {
    self.postMessage({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
      duration_ms: Date.now() - start,
      status: 500,
      body: '',
    });
  }
};
