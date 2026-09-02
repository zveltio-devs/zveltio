#!/usr/bin/env bun
/**
 * ci-check.ts — Run the bench against the local engine and fail the build if
 * a critical p95 exceeds the upper-bound threshold.
 *
 * Thresholds flag *catastrophic* regressions only — roughly a 10x slowdown —
 * not p99 drift. CI runners have variable load and cold caches. To track drift,
 * archive `bench/results/latest.json` as a CI artifact and compare across PRs
 * out-of-band.
 *
 * ── The budgets are DERIVED, and they were not ────────────────
 *
 * They used to be five hand-picked round numbers, and the headroom they left
 * varied by a factor of seven:
 *
 *     metric        master   budget   headroom
 *     create        102,8ms    300ms      2,9x
 *     get            38,6ms    200ms      5,2x
 *     patch          85,5ms    300ms      3,5x
 *     delete         10,0ms    200ms     20,0x
 *     list.first     40,9ms    300ms      7,3x
 *
 * `create` therefore had under a third of the headroom this comment promised,
 * which made it a drift detector by accident — and a flaky one. Measured on
 * 2026-09-01: two unrelated PRs failed this job, once on `delete` and once on
 * `create`, with EVERY metric inflated 2,4-4,8x. That is a slow runner, not a
 * regression: a regression moves one number, load moves all of them.
 *
 * A gate that fails at random teaches people to press re-run without reading,
 * which costs more than the gate is worth.
 *
 * So the budgets come from one baseline table times one multiplier. Changing
 * how strict this gate is means changing `SLOWDOWN_FACTOR`, in one place,
 * instead of five numbers drifting apart again.
 *
 * Tunable via env (each still overrides its own metric):
 *   PERF_BUDGET_CREATE_P95_MS · PERF_BUDGET_GET_P95_MS · PERF_BUDGET_PATCH_P95_MS
 *   PERF_BUDGET_DELETE_P95_MS · PERF_BUDGET_LIST_FIRST_P95_MS
 *
 * Exit codes:
 *   0 — all budgets met
 *   1 — at least one budget exceeded (CI fails)
 *   2 — bench itself errored (config / engine unreachable)
 */

import { readFile } from 'node:fs/promises';

/**
 * p95 on a healthy CI runner, measured on master 2026-09-01. Not aspirations —
 * observations, so the headroom below is a real multiple of real behaviour.
 *
 * When the engine genuinely gets faster or slower for a reason, update these
 * and say why in the commit. That is the drift record this gate does not keep.
 */
const CI_BASELINE_MS = {
  create: 103,
  get: 39,
  patch: 86,
  delete: 10,
  listFirst: 41,
} as const;

/**
 * How far past the baseline is "catastrophic". One number, because five that
 * drift apart is how `create` ended up with 2,9x headroom while `delete` had 20x.
 *
 * Ten is what the header has always claimed. Runner noise measured at 2,4-4,8x,
 * so this clears it with room and still catches an order-of-magnitude loss.
 */
const SLOWDOWN_FACTOR = 10;

/**
 * The budgets this replaced. A floor, never a ceiling.
 *
 * Deriving from the baseline would have TIGHTENED `delete` — 10ms x 10 is 100,
 * against 200 before — and tightening a budget as a side effect of fixing
 * flakiness is how a fix becomes the next flake. Nothing here gets stricter
 * than what it replaced; the derivation only ever adds headroom.
 */
const PREVIOUS_BUDGET_MS = {
  create: 300,
  get: 200,
  patch: 300,
  delete: 200,
  listFirst: 300,
} as const;

/** Baseline for a printed metric name like `create.p95`. */
function baselineFor(metricName: string): number {
  const key = metricName.replace('.p95', '').replace('list.first', 'listFirst');
  return CI_BASELINE_MS[key as keyof typeof CI_BASELINE_MS] ?? 1;
}

function budgetFor(metric: keyof typeof CI_BASELINE_MS): number {
  return Math.max(PREVIOUS_BUDGET_MS[metric], Math.round(CI_BASELINE_MS[metric] * SLOWDOWN_FACTOR));
}
import { loadConfig } from './lib/config.js';
import { signInForToken, waitForHealthy } from './lib/http.js';
import { runRestCrud } from './benchmarks/rest-crud.bench.js';
import { runListPagination } from './benchmarks/list-pagination.bench.js';

interface Budget {
  name: string;
  value: number;
  budget: number;
}

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
    {
      name: 'create.p95',
      value: crud.create.p95,
      budget: Number(process.env.PERF_BUDGET_CREATE_P95_MS ?? budgetFor('create')),
    },
    {
      name: 'get.p95',
      value: crud.get.p95,
      budget: Number(process.env.PERF_BUDGET_GET_P95_MS ?? budgetFor('get')),
    },
    {
      name: 'patch.p95',
      value: crud.patch.p95,
      budget: Number(process.env.PERF_BUDGET_PATCH_P95_MS ?? budgetFor('patch')),
    },
    {
      name: 'delete.p95',
      value: crud.delete.p95,
      budget: Number(process.env.PERF_BUDGET_DELETE_P95_MS ?? budgetFor('delete')),
    },
    {
      name: 'list.first.p95',
      value: list.firstPage.p95,
      budget: Number(process.env.PERF_BUDGET_LIST_FIRST_P95_MS ?? budgetFor('listFirst')),
    },
  ];

  let failed = 0;
  console.log('\nResult:');
  console.log('─'.repeat(60));
  // Print each metric's inflation over the baseline, not just pass/fail.
  //
  // This is the line that makes a failure readable. A regression moves ONE
  // number; a loaded runner moves all of them. Both looked identical in the old
  // output — five values and a budget — so the only way to tell them apart was
  // to re-run and see whether it happened again, which is exactly the habit a
  // flaky gate teaches and the reason it stops being read.
  const ratios = budgets.map((b) => b.value / baselineFor(b.name));
  const median = [...ratios].sort((a, z) => a - z)[Math.floor(ratios.length / 2)] ?? 1;
  /**
   * The failing metric the message is about — chosen from the ones that FAILED,
   * not from all five.
   *
   * The first version took the highest ratio overall, which is a different
   * question and gave the wrong answer: a run where `create` broke its budget
   * printed advice about `delete`, because `delete` happened to sit further
   * above its (much smaller) baseline while still passing. Caught by planting a
   * failure, not by reading it.
   */
  const failing = budgets.filter((b) => !(Number.isFinite(b.value) && b.value <= b.budget));
  const worst = (failing.length > 0 ? failing : budgets).reduce((a, b) =>
    b.value / baselineFor(b.name) > a.value / baselineFor(a.name) ? b : a,
  );

  for (const [i, b] of budgets.entries()) {
    const ok = Number.isFinite(b.value) && b.value <= b.budget;
    const mark = ok ? '✓' : '✗';
    console.log(
      `${mark} ${b.name.padEnd(20)} ${b.value.toFixed(1).padStart(7)} ms  ` +
        `(budget ${b.budget} ms, ${ratios[i]!.toFixed(1)}x baseline)`,
    );
    if (!ok) failed++;
  }

  if (failed > 0) {
    console.log('─'.repeat(60));
    if (median >= 2) {
      console.log(
        `⚠  EVERY metric is inflated (median ${median.toFixed(1)}x baseline). That is the\n` +
          '   signature of a loaded runner, not a regression — a regression moves one\n' +
          '   number and leaves the rest flat. Re-run before investigating the code.',
      );
    } else {
      // Deliberately weaker than the branch above, and the asymmetry is the
      // point. "All five moved" has only one plausible cause. "One moved" has
      // two, and this heuristic cannot tell them apart: a real regression and a
      // metric that was simply noisy this run look identical from here.
      //
      // It matters most exactly where it reads worst. `delete` has a 10 ms
      // baseline, so the ordinary jitter of a shared runner is a large multiple
      // of it: master's own last six runs were 7.4, 12.5, 8.2, 37.8, 11.6 and
      // 9.0 ms. A 240 ms sample printed "24.1x baseline" and this line called it
      // a real regression; the re-run came back at 9.1 ms.
      //
      // Saying "re-run" is not the habit a flaky gate teaches — that is reading
      // a failure and ignoring it. This asks for one more sample and then tells
      // you what each answer means, which is the opposite.
      const small = baselineFor(worst.name) < 25;
      console.log(
        `→  Only ${worst.name} moved (${(worst.value / baselineFor(worst.name)).toFixed(1)}x baseline); the rest are near it ` +
          `(median ${median.toFixed(1)}x).\n` +
          '   So this is NOT general runner slowness.\n' +
          (small
            ? `   But ${worst.name}'s baseline is only ${baselineFor(worst.name)} ms, small enough that ordinary\n` +
              '   runner jitter shows up as a large multiple on its own. Re-run: if it comes\n' +
              '   back near baseline it was noise, and if it stays high it is real.\n'
            : '   Treat it as a real regression.\n'),
      );
    }
  }
  console.log('─'.repeat(60));

  // Re-emit JSON for the artifact upload step
  const payload = { generatedAt: new Date().toISOString(), budgets, raw: { crud, list } };
  await Bun.write('bench/results/ci.json', JSON.stringify(payload, null, 2));

  if (failed > 0) {
    console.error(
      `\n✗ ${failed}/${budgets.length} budget(s) exceeded — see thresholds in bench/ci-check.ts`,
    );
    process.exit(1);
  }
  console.log(`\n✓ all ${budgets.length} budgets met`);
}

main().catch(async (err) => {
  console.error('✗ ci-check failed:', err?.message ?? err);
  // Helpful: dump latest result file if it exists so we can debug from the log.
  try {
    console.error(await readFile('bench/results/ci.json', 'utf8'));
  } catch {
    /* ignore */
  }
  process.exit(2);
});
