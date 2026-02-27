/**
 * Edge function sandboxed executor
 *
 * Uses Bun's built-in transpiler to evaluate TypeScript at runtime.
 * Functions receive a simplified context and must return a Response.
 */

export interface FunctionContext {
  request: Request;
  env: Record<string, string>;
  // Minimal SDK surface exposed to functions
  db?: any;
}

const FUNCTION_TEMPLATE = `
// --- User code below ---
{{USER_CODE}}
// --- End user code ---

// Default export must be a function: (ctx: FunctionContext) => Response | Promise<Response>
`;

const STDLIB = `
// Stdlib available to edge functions
const console = {
  log: (...args) => _zveltio_log('log', args),
  error: (...args) => _zveltio_log('error', args),
  warn: (...args) => _zveltio_log('warn', args),
};
`;

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
  timeoutMs = 30000,
): Promise<RunResult> {
  const logs: string[] = [];
  const start = Date.now();

  try {
    // Build sandboxed module
    const sandboxedCode = `
${STDLIB}
${code}
`;

    // Transpile TypeScript -> JS using Bun transpiler
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const js = transpiler.transformSync(sandboxedCode);

    // Create a safe globals object
    const safeGlobals = {
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
      console: {
        log: (...args: any[]) => logs.push(`[log] ${args.join(' ')}`),
        error: (...args: any[]) => logs.push(`[err] ${args.join(' ')}`),
        warn: (...args: any[]) => logs.push(`[warn] ${args.join(' ')}`),
      },
      _zveltio_log: (level: string, args: any[]) => logs.push(`[${level}] ${args.join(' ')}`),
    };

    // Evaluate in a function scope (not fully sandboxed — production would use isolates)
    const fn = new Function(
      ...Object.keys(safeGlobals),
      `${js}; return typeof handler !== 'undefined' ? handler : (typeof module !== 'undefined' ? module.exports?.default : null);`,
    );

    const handler = fn(...Object.values(safeGlobals));

    if (typeof handler !== 'function') {
      return { status: 500, body: 'Function must export a default handler', logs, duration_ms: 0, error: 'No handler exported' };
    }

    const ctx: FunctionContext = { request, env };

    // Execute with timeout
    const timeoutPromise = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error(`Function timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    const result: Response = await Promise.race([handler(ctx), timeoutPromise]);
    const body = await result.text();
    const duration_ms = Date.now() - start;

    return { status: result.status, body, logs, duration_ms };
  } catch (err) {
    return {
      status: 500,
      body: '',
      logs,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
