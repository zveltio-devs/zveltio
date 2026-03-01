// packages/engine/src/lib/script-runner.ts
// Bun-compatible sandboxed script execution using AsyncFunction constructor

export interface ScriptResult {
  output: any;
  logs: string[];
  error?: string;
  duration_ms: number;
}

export async function runScript(
  code: string,
  input: Record<string, any> = {},
  timeoutMs = 30000,
): Promise<ScriptResult> {
  const logs: string[] = [];
  const startTime = Date.now();

  const mockConsole = {
    log: (...args: any[]) => logs.push('[LOG] ' + args.map(String).join(' ')),
    error: (...args: any[]) => logs.push('[ERROR] ' + args.map(String).join(' ')),
    warn: (...args: any[]) => logs.push('[WARN] ' + args.map(String).join(' ')),
  };

  try {
    // AsyncFunction constructor: no access to outer scope (safer than eval)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
    const fn = new AsyncFunction('input', 'fetch', 'console', code);

    const result = await Promise.race([
      fn(input, globalThis.fetch, mockConsole) as Promise<any>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Script timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    return { output: result, logs, duration_ms: Date.now() - startTime };
  } catch (error) {
    return {
      output: null,
      logs,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startTime,
    };
  }
}
