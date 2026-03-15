/// <reference types="bun-types" />

/**
 * Edge function worker runner — executes user code in an isolated Bun Worker thread.
 * This file runs in a separate thread, preventing infinite loops from freezing the server.
 *
 * Security hardening:
 *   - SSRF protection: fetch is replaced with safeFetch that blocks internal/private addresses
 *   - Prototype pollution prevention: dangerous globals are explicitly blocked
 *   - Security prefix injected into user code to shadow dangerous identifiers
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

// ═══ SSRF Protection ═══
const BLOCKED_PREFIXES = [
  // Loopback
  'http://localhost', 'https://localhost',
  'http://127.', 'https://127.',
  'http://0.0.0.0', 'https://0.0.0.0',
  'http://[::1]', 'https://[::1]',
  // AWS/GCP/Azure Metadata
  'http://169.254.', 'https://169.254.',
  // Private networks (RFC 1918)
  'http://10.', 'https://10.',
  'http://172.16.', 'https://172.16.',
  'http://172.17.', 'https://172.17.',
  'http://172.18.', 'https://172.18.',
  'http://172.19.', 'https://172.19.',
  'http://172.20.', 'https://172.20.',
  'http://172.21.', 'https://172.21.',
  'http://172.22.', 'https://172.22.',
  'http://172.23.', 'https://172.23.',
  'http://172.24.', 'https://172.24.',
  'http://172.25.', 'https://172.25.',
  'http://172.26.', 'https://172.26.',
  'http://172.27.', 'https://172.27.',
  'http://172.28.', 'https://172.28.',
  'http://172.29.', 'https://172.29.',
  'http://172.30.', 'https://172.30.',
  'http://172.31.', 'https://172.31.',
  'http://192.168.', 'https://192.168.',
  // Docker internal
  'http://host.docker.internal', 'https://host.docker.internal',
  // Kubernetes
  'http://kubernetes.default', 'https://kubernetes.default',
];

/**
 * Secure fetch that blocks requests to internal/private networks.
 * Prevents SSRF attacks from Edge Functions.
 */
const safeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    throw new Error('Invalid fetch input');
  }

  const lower = url.toLowerCase();
  for (const prefix of BLOCKED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      throw new Error(
        `[Zveltio Sandbox] Network access to internal address blocked: ${url}. ` +
        `Edge Functions can only access public internet endpoints.`,
      );
    }
  }

  // Block non-http/https schemes
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    throw new Error(`[Zveltio Sandbox] Only http:// and https:// URLs are allowed. Got: ${url}`);
  }

  return fetch(input, init);
};

// ═══ Security prefix injected before user code ═══
// Shadows dangerous globals so user code cannot access them via identifier lookup.
const SECURITY_PREFIX = `
'use strict';
const process = undefined;
const require = undefined;
const module = undefined;
const exports = undefined;
const global = undefined;
const globalThis = undefined;
const Bun = undefined;
const Deno = undefined;
const self = undefined;
const eval = undefined;
const Function = undefined;
const importScripts = undefined;
`;

self.onmessage = async (e: MessageEvent<WorkerPayload>) => {
  const { code, requestData, env } = e.data;
  const logs: string[] = [];
  const start = Date.now();

  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const js = transpiler.transformSync(`${STDLIB}\n${code}`);

    const safeGlobals: Record<string, any> = {
      // ═══ Allowed globals ═══
      fetch: safeFetch,   // Proxy securizat, NU fetch direct
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

      // ═══ Explicit blocks — prevents escape from sandbox ═══
      process: undefined,
      require: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,
      global: undefined,
      globalThis: undefined,
      Bun: undefined,
      Deno: undefined,
      self: undefined,           // Block access to worker self
      postMessage: undefined,    // Block direct parent communication
      importScripts: undefined,  // Block external script loading
      eval: undefined,           // Block recursive eval
      Function: undefined,       // Block new Function creation
    };

    const fn = new Function(
      ...Object.keys(safeGlobals),
      `${SECURITY_PREFIX}\n${js}; return typeof handler !== 'undefined' ? handler : (typeof module !== 'undefined' ? module.exports?.default : null);`,
    );

    // Freeze prototypes to prevent prototype pollution attacks
    // Safe in worker thread — does NOT propagate to parent process
    try {
      Object.freeze(Object.prototype);
      Object.freeze(Array.prototype);
      Object.freeze(String.prototype);
    } catch {
      // Already frozen or unsupported — continue
    }

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
