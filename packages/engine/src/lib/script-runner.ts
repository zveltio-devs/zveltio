// packages/engine/src/lib/script-runner.ts
// Secure script execution via the isolated worker sandbox.
//
// SECURITY: AsyncFunction was removed because it runs in the same V8 context
// as the engine, giving user code access to globalThis, process.env, Bun.env,
// and all engine internals.
//
// All script execution is delegated to sandbox.ts / worker-runner.ts which uses:
//   - Bun Worker (separate process with message passing)
//   - SSRF protection on fetch()
//   - 64 MB memory watchdog
//   - Prototype freeze on globals
//   - Dangerous globals (process, Bun, globalThis, eval, Function) shadowed to undefined

import { runFunction } from './edge-functions/sandbox.js';

export interface ScriptResult {
  output: any;
  logs: string[];
  error?: string;
  duration_ms: number;
}

export async function runScript(
  code: string,
  input: Record<string, any> = {},
  timeoutMs = 30_000,
): Promise<ScriptResult> {
  const startTime = Date.now();

  // Wrap user code as an edge-function handler.
  // The worker (worker-runner.ts) prepends STDLIB which defines `_logs` and `console`.
  // The handler receives `input` from the request body and returns the result as JSON.
  // `_logs` is accessible via closure from STDLIB scope.
  const wrappedCode = `
export default async function handler(ctx) {
  const input = await ctx.request.json().catch(() => ({}));
  let __output;
  try {
    __output = await (async () => {
      ${code}
    })();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e), logs: _logs }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({ output: __output, logs: _logs }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
`;

  const mockRequest = new Request('http://internal/run-script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  try {
    const result = await runFunction(wrappedCode, mockRequest, {}, timeoutMs);

    if (result.error && !result.body) {
      return {
        output: null,
        logs: result.logs ?? [],
        error: result.error,
        duration_ms: Date.now() - startTime,
      };
    }

    let parsed: { output?: any; logs?: string[]; error?: string } = {};
    try {
      parsed = JSON.parse(result.body);
    } catch {
      parsed = { output: result.body };
    }

    return {
      output: parsed.output ?? null,
      logs: [...(result.logs ?? []), ...(parsed.logs ?? [])],
      error: parsed.error ?? result.error,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    return {
      output: null,
      logs: [],
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startTime,
    };
  }
}
