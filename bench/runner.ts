#!/usr/bin/env bun
/**
 * Bench runner — orchestrates the suite and writes results to JSON.
 *
 * Invocation:
 *   bun run bench/runner.ts
 *
 * Env (defaults in bench/lib/config.ts):
 *   BENCH_BASE_URL, BENCH_EMAIL, BENCH_PASSWORD
 *   BENCH_WARMUP, BENCH_ITERATIONS, BENCH_CONCURRENCY
 *   BENCH_TAG       — prefix for the output filename
 *   BENCH_VARIANT   — `zveltio` (default) or `pocketbase`
 *   BENCH_SKIP      — comma-separated list of bench names to skip
 *                     (crud,list,realtime,coldstart)
 *
 * Output: bench/results/<tag>-<isotime>.json
 *
 * The runner does NOT spawn the engine itself — that's the operator's job.
 * It does verify the engine is reachable before running, so a misconfigured
 * BENCH_BASE_URL fails fast instead of producing N timeout samples.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig } from './lib/config.js';
import { signInForToken, waitForHealthy } from './lib/http.js';
import { formatStats } from './lib/stats.js';
import { runRestCrud } from './benchmarks/rest-crud.bench.js';
import { runListPagination } from './benchmarks/list-pagination.bench.js';
import { runRealtime } from './benchmarks/realtime.bench.js';

async function main() {
  const cfg = loadConfig();
  const variant = process.env.BENCH_VARIANT ?? 'zveltio';
  const tag = process.env.BENCH_TAG ?? variant;
  const skip = new Set((process.env.BENCH_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  console.log(`▶ Bench runner — variant=${variant}, baseUrl=${cfg.baseUrl}`);
  console.log(`  warmup=${cfg.warmup} iterations=${cfg.iterations} concurrency=${cfg.concurrency}`);

  await waitForHealthy(cfg.baseUrl, 10_000).catch(() => {
    throw new Error(`engine not reachable at ${cfg.baseUrl} — start it first`);
  });

  if (variant === 'pocketbase') {
    return runPocketbase(cfg, tag, skip);
  }

  const token = await signInForToken(cfg.baseUrl, cfg.email, cfg.password);
  const client = { baseUrl: cfg.baseUrl, authToken: token };

  const results: Record<string, unknown> = {
    meta: {
      variant,
      tag,
      baseUrl: cfg.baseUrl,
      iterations: cfg.iterations,
      warmup: cfg.warmup,
      concurrency: cfg.concurrency,
      timestamp: new Date().toISOString(),
      bunVersion: Bun.version,
    },
  };

  if (!skip.has('crud')) {
    console.log('\n▶ REST CRUD');
    const r = await runRestCrud({ client, warmup: cfg.warmup, iterations: cfg.iterations, concurrency: cfg.concurrency });
    results.restCrud = r;
    console.log(formatStats('  create', r.create));
    console.log(formatStats('  get   ', r.get));
    console.log(formatStats('  patch ', r.patch));
    console.log(formatStats('  delete', r.delete));
  }

  if (!skip.has('list')) {
    console.log('\n▶ List + pagination (seed 5k rows, may take ~30s)');
    const r = await runListPagination({ client, warmup: cfg.warmup, iterations: cfg.iterations });
    results.listPagination = r;
    console.log(formatStats(`  page=1`, r.firstPage));
    console.log(formatStats(`  page=${r.deepPageNumber}`, r.deepPage));
    console.log(formatStats(`  cursor`, r.cursor));
  }

  if (!skip.has('realtime')) {
    console.log('\n▶ Realtime WS fan-out');
    const sessionCookie = process.env.BENCH_SESSION_COOKIE;
    const r = await runRealtime({ client, warmup: Math.min(5, cfg.warmup), iterations: Math.min(50, cfg.iterations), sessionCookie });
    results.realtime = r;
    if (r.skipped) {
      console.log(`  skipped: ${r.skipped}`);
    } else {
      console.log(formatStats('  e2e (POST→WS)   ', r.fanout));
      console.log(formatStats('  postReturned→WS ', r.postToWs));
    }
  }

  if (!skip.has('coldstart')) {
    // Cold-start is opt-in: it spawns child processes and assumes the engine
    // build artifact + a dedicated DB. Most users want REST/list numbers, not
    // cold-start. Enable with BENCH_COLDSTART=1.
    if (process.env.BENCH_COLDSTART === '1') {
      const { runColdStart } = await import('./benchmarks/cold-start.bench.js');
      console.log('\n▶ Cold start');
      const r = await runColdStart({
        enginePath: join(process.cwd(), 'packages/engine'),
        warmup: 1,
        iterations: 5,
        startPort: 4100,
        env: process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {},
      });
      results.coldStart = r;
      if (r.skipped) {
        console.log(`  skipped: ${r.skipped}`);
      } else {
        console.log(formatStats('  spawn → first byte', r.spawnToFirstByte));
        console.log(formatStats('  spawn → healthy   ', r.spawnToHealthy));
      }
    } else {
      console.log('\n▶ Cold start — skipped (set BENCH_COLDSTART=1 to enable)');
    }
  }

  await writeResults(results, tag);
}

async function runPocketbase(
  cfg: ReturnType<typeof loadConfig>,
  tag: string,
  skip: Set<string>,
): Promise<void> {
  const { pbAdminAuth, runPbCrud } = await import('./compare/pocketbase/client.js');
  const token = await pbAdminAuth(cfg.baseUrl, cfg.email, cfg.password);
  const client = { baseUrl: cfg.baseUrl, authToken: token };

  const results: Record<string, unknown> = {
    meta: {
      variant: 'pocketbase',
      tag,
      baseUrl: cfg.baseUrl,
      iterations: cfg.iterations,
      warmup: cfg.warmup,
      timestamp: new Date().toISOString(),
    },
  };

  if (!skip.has('crud')) {
    console.log('\n▶ Pocketbase REST CRUD');
    const r = await runPbCrud({ client, warmup: cfg.warmup, iterations: cfg.iterations });
    results.restCrud = r;
    console.log(formatStats('  create', r.create));
    console.log(formatStats('  get   ', r.get));
    console.log(formatStats('  patch ', r.patch));
    console.log(formatStats('  delete', r.delete));
  }

  await writeResults(results, tag);
}

async function writeResults(results: Record<string, unknown>, tag: string): Promise<void> {
  const cfg = loadConfig();
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${tag}-${isoStamp}.json`;
  const outDir = dirname(cfg.outputPath);
  await mkdir(outDir, { recursive: true });
  const fullPath = join(outDir, filename);
  await writeFile(fullPath, JSON.stringify(results, null, 2));
  // Also overwrite a stable `latest.json` pointer for diffing.
  await writeFile(cfg.outputPath, JSON.stringify(results, null, 2));
  console.log(`\n✓ Results: ${fullPath}`);
}

main().catch((err) => {
  console.error('✗ Bench failed:', err.message);
  process.exit(1);
});
