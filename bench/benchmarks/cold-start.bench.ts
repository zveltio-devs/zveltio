/**
 * Cold-start benchmark — process spawn → first 200 on /api/health.
 *
 * Why this matters: cold-start dominates serverless cost and dev DX.
 * We measure two phases:
 *   - spawnToFirstByte: spawn → first byte of stdout (engine logs banner)
 *   - spawnToHealthy:   spawn → /api/health responds 200
 *
 * Each iteration uses a fresh child process bound to an unused port so
 * we never compete with a running dev server. We assume `bun run start`
 * inside packages/engine works (i.e. dist/index.js is built). The runner
 * will check this and skip with a friendly message otherwise.
 */

import { spawn } from 'node:child_process';
import { waitForHealthy } from '../lib/http.js';
import { summarize, type SampleStats } from '../lib/stats.js';

export interface ColdStartResult {
  iterations: number;
  spawnToFirstByte: SampleStats;
  spawnToHealthy: SampleStats;
  skipped?: string;
}

interface RunOptions {
  enginePath: string; // absolute path to engine package dir
  warmup: number;
  iterations: number;
  startPort: number; // each iteration gets startPort+i
  /** Extra env vars (e.g. DATABASE_URL) to pass to each child. */
  env?: Record<string, string>;
}

export async function runColdStart(opts: RunOptions): Promise<ColdStartResult> {
  const { enginePath, warmup, iterations, startPort, env = {} } = opts;

  // Warmup: discard timings (fills caches).
  for (let i = 0; i < warmup; i++) {
    const port = startPort + 9000 + i;
    await spawnAndWait(enginePath, port, env).catch(() => undefined);
  }

  const firstByte: number[] = [];
  const healthy: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const port = startPort + i;
    const m = await spawnAndWait(enginePath, port, env);
    firstByte.push(m.spawnToFirstByte);
    healthy.push(m.spawnToHealthy);
  }

  return {
    iterations,
    spawnToFirstByte: summarize(firstByte),
    spawnToHealthy: summarize(healthy),
  };
}

interface OneShot {
  spawnToFirstByte: number;
  spawnToHealthy: number;
}

async function spawnAndWait(
  enginePath: string,
  port: number,
  env: Record<string, string>,
): Promise<OneShot> {
  const t0 = performance.now();
  let firstByteAt = Number.NaN;

  const child = spawn('bun', ['run', 'start'], {
    cwd: enginePath,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.once('data', () => {
    firstByteAt = performance.now();
  });

  try {
    const healthyAfter = await waitForHealthy(`http://localhost:${port}`, 60_000);
    return {
      spawnToFirstByte: Number.isFinite(firstByteAt) ? firstByteAt - t0 : Number.NaN,
      spawnToHealthy: healthyAfter,
    };
  } finally {
    child.kill('SIGTERM');
    // Best-effort wait for child to exit so port is released before next iter.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
