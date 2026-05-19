#!/usr/bin/env bun
/**
 * ci-check.ts — Run the bench against the local engine and fail the build if
 * a critical p95 exceeds the upper-bound threshold.
 *
 * Thresholds are intentionally generous: CI runners have variable load and
 * cold caches, so we only flag *catastrophic* regressions (10× slowdowns),
 * not p99 drift. To track drift, archive `bench/results/latest.json` as a
 * CI artifact and compare across PRs out-of-band.
 *
 * Tunable via env:
 *   PERF_BUDGET_CREATE_P95_MS     (default 300)
 *   PERF_BUDGET_GET_P95_MS        (default 200)
 *   PERF_BUDGET_PATCH_P95_MS      (default 300)
 *   PERF_BUDGET_DELETE_P95_MS     (default 200)
 *   PERF_BUDGET_LIST_FIRST_P95_MS (default 300)
 *
 * Exit codes:
 *   0 — all budgets met
 *   1 — at least one budget exceeded (CI fails)
 *   2 — bench itself errored (config / engine unreachable)
 */

import { readFile } from 'node:fs/promises';
import { loadConfig } from './lib/config.js';
import { signInForToken, waitForHealthy } from './lib/http.js';
import { runRestCrud } from './benchmarks/rest-crud.bench.js';
import { runListPagination } from './benchmarks/list-pagination.bench.js';

interface Budget { name: string; value: number; budget: number }

async function main(): Promise<void> {
  const cfg = loadConfig();
  await waitForHealthy(cfg.baseUrl, 10_000).catch(() => {
    console.error(`✗ engine not reachable at ${cfg.baseUrl}`);
    process.exit(2);
  });

  const token = await signInForToken(cfg.baseUrl, cfg.email, cfg.password);
  const client = { baseUrl: cfg.baseUrl, authToken: token };

  // Use smaller counts for CI — we care about catastrophic regression,
  // not perfect statistical confidence. 30 iters * 4 phases ≈ 5–10s total.
  const warmup = 5;
  const iterations = 30;

  console.log('▶ CI bench: REST CRUD');
  const crud = await runRestCrud({ client, warmup, iterations, concurrency: 1 });
  console.log('▶ CI bench: list+pagination (small seed)');
  // 200 rows seeds in one bulk batch (the route caps at 500/request).
  // Deep-page test still walks to page 10 with pageSize 20 — enough to
  // detect catastrophic offset-pagination regressions.
  const list = await runListPagination({ client, warmup, iterations: 20, seedRows: 200 });

  const budgets: Budget[] = [
    { name: 'create.p95',     value: crud.create.p95, budget: Number(process.env.PERF_BUDGET_CREATE_P95_MS     ?? 300) },
    { name: 'get.p95',        value: crud.get.p95,    budget: Number(process.env.PERF_BUDGET_GET_P95_MS        ?? 200) },
    { name: 'patch.p95',      value: crud.patch.p95,  budget: Number(process.env.PERF_BUDGET_PATCH_P95_MS      ?? 300) },
    { name: 'delete.p95',     value: crud.delete.p95, budget: Number(process.env.PERF_BUDGET_DELETE_P95_MS     ?? 200) },
    { name: 'list.first.p95', value: list.firstPage.p95, budget: Number(process.env.PERF_BUDGET_LIST_FIRST_P95_MS ?? 300) },
  ];

  let failed = 0;
  console.log('\nResult:');
  console.log('─'.repeat(60));
  for (const b of budgets) {
    const ok = Number.isFinite(b.value) && b.value <= b.budget;
    const mark = ok ? '✓' : '✗';
    console.log(`${mark} ${b.name.padEnd(20)} ${b.value.toFixed(1).padStart(7)} ms  (budget ${b.budget} ms)`);
    if (!ok) failed++;
  }
  console.log('─'.repeat(60));

  // Re-emit JSON for the artifact upload step
  const payload = { generatedAt: new Date().toISOString(), budgets, raw: { crud, list } };
  await Bun.write('bench/results/ci.json', JSON.stringify(payload, null, 2));

  if (failed > 0) {
    console.error(`\n✗ ${failed}/${budgets.length} budget(s) exceeded — see thresholds in bench/ci-check.ts`);
    process.exit(1);
  }
  console.log(`\n✓ all ${budgets.length} budgets met`);
}

main().catch(async (err) => {
  console.error('✗ ci-check failed:', err?.message ?? err);
  // Helpful: dump latest result file if it exists so we can debug from the log.
  try { console.error(await readFile('bench/results/ci.json', 'utf8')); } catch { /* ignore */ }
  process.exit(2);
});
