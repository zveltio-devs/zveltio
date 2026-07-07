/**
 * H-15 — soak driver. Drives mixed traffic for SOAK_MINUTES (default 60) while
 * sampling RSS from the engine's /metrics endpoint every SOAK_SAMPLE_SEC, then
 * asserts the engine isn't leaking:
 *   - RSS slope over the final 30 min (scaled for shorter runs) < 1 MB/min,
 *   - zero unhandled rejections,
 *   - p95 late-window within 1.5× of the early window.
 * Writes the RSS/latency timeseries to SOAK_OUT for the workflow to upload.
 *
 * Reuses the bench/ HTTP drivers + stats. Env: BENCH_BASE_URL / BENCH_EMAIL /
 * BENCH_PASSWORD (same as ci-check), METRICS_TOKEN, SOAK_MINUTES,
 * SOAK_SAMPLE_SEC, SOAK_OUT.
 */

import { loadConfig } from './lib/config.js';
import {
  type BenchHttpClient,
  signInForToken,
  timedDelete,
  timedGet,
  timedPatch,
  timedPost,
  waitForHealthy,
} from './lib/http.js';
import { percentile } from './lib/stats.js';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const SAMPLE_SEC = Number(process.env.SOAK_SAMPLE_SEC ?? 30);
const OUT = process.env.SOAK_OUT ?? 'bench/results/soak-timeseries.json';
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? '';
const RSS_SLOPE_LIMIT = Number(process.env.SOAK_RSS_SLOPE_MB_MIN ?? 1); // MB/min
const P95_GROWTH_LIMIT = Number(process.env.SOAK_P95_GROWTH ?? 1.5);

interface Sample {
  minute: number;
  rssMB: number;
  p95ms: number;
  reqs: number;
}

let unhandled = 0;
process.on('unhandledRejection', (reason) => {
  unhandled++;
  console.error('[soak] unhandledRejection:', reason);
});

async function scrapeRssMB(baseUrl: string): Promise<number> {
  const url = `${baseUrl}/metrics${METRICS_TOKEN ? `?token=${METRICS_TOKEN}` : ''}`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return Number.NaN;
  const text = await res.text();
  const m = /zveltio_memory_rss_bytes\s+(\d+)/.exec(text);
  return m ? Number(m[1]) / 1024 / 1024 : Number.NaN;
}

/** Least-squares slope of y over x (MB per minute). */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** The sample whose minute is closest to `target`. */
function nearest(samples: Sample[], target: number): Sample | undefined {
  if (samples.length === 0) return undefined;
  return samples.reduce((best, s) =>
    Math.abs(s.minute - target) < Math.abs(best.minute - target) ? s : best,
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  await waitForHealthy(cfg.baseUrl, 60_000);
  const token = await signInForToken(cfg.baseUrl, cfg.email, cfg.password);
  const client: BenchHttpClient = { baseUrl: cfg.baseUrl, authToken: token };

  // Dedicated soak collection.
  const name = `soak_${Date.now()}`;
  await timedPost(client, '/api/collections', {
    name,
    fields: [
      { name: 'title', type: 'text' },
      { name: 'count', type: 'number' },
    ],
  });
  for (let i = 0; i < 30; i++) {
    if ((await timedGet(client, `/api/data/${name}`)).status === 200) break;
    await Bun.sleep(1000);
  }

  const samples: Sample[] = [];
  const ids: string[] = [];
  let latencies: number[] = [];
  let reqs = 0;
  const start = Date.now();
  const end = start + MINUTES * 60_000;
  let stop = false;

  // Continuous mixed traffic: create / get / list / patch, with bounded delete
  // churn so the working set stays flat (a real leak shows up as rising RSS, not
  // just row growth).
  const traffic = (async () => {
    let i = 0;
    while (!stop && Date.now() < end) {
      const cr = await timedPost(client, `/api/data/${name}`, { title: `row-${i}`, count: i });
      latencies.push(cr.durationMs);
      reqs++;
      const id =
        (cr.body as { id?: string; record?: { id?: string } })?.record?.id ??
        (cr.body as { id?: string })?.id;
      if (id) ids.push(id);

      if (ids.length > 0) {
        const g = await timedGet(client, `/api/data/${name}/${ids[i % ids.length]}`);
        latencies.push(g.durationMs);
        reqs++;
      }
      const l = await timedGet(client, `/api/data/${name}?limit=20`);
      latencies.push(l.durationMs);
      reqs++;
      if (ids.length > 0) {
        const p = await timedPatch(client, `/api/data/${name}/${ids[i % ids.length]}`, {
          count: i,
        });
        latencies.push(p.durationMs);
        reqs++;
      }
      if (ids.length > 200) {
        const victim = ids.shift()!;
        const d = await timedDelete(client, `/api/data/${name}/${victim}`);
        latencies.push(d.durationMs);
        reqs++;
      }
      i++;
    }
  })();

  // Sampler.
  while (Date.now() < end) {
    await Bun.sleep(SAMPLE_SEC * 1000);
    const minute = (Date.now() - start) / 60_000;
    const rssMB = await scrapeRssMB(cfg.baseUrl);
    const p95ms = latencies.length ? percentile(latencies, 95) : 0;
    const s: Sample = {
      minute: +minute.toFixed(2),
      rssMB: +rssMB.toFixed(1),
      p95ms: +p95ms.toFixed(1),
      reqs,
    };
    samples.push(s);
    console.log(
      `[soak] t=${minute.toFixed(1)}min rss=${rssMB.toFixed(0)}MB p95=${p95ms.toFixed(0)}ms reqs=${reqs}`,
    );
    latencies = [];
    reqs = 0;
  }
  stop = true;
  await traffic.catch(() => {});

  await Bun.write(
    OUT,
    JSON.stringify({ minutes: MINUTES, sampleSec: SAMPLE_SEC, unhandled, samples }, null, 2),
  );

  // ── Assertions ───────────────────────────────────────────────────────────
  const failures: string[] = [];

  // RSS slope over the final window (30 min for a full run; scaled for short).
  const slopeWindow = Math.min(30, MINUTES / 2);
  const tail = samples.filter((s) => s.minute >= MINUTES - slopeWindow && Number.isFinite(s.rssMB));
  const rssSlope = slope(
    tail.map((s) => s.minute),
    tail.map((s) => s.rssMB),
  );
  if (tail.length >= 2 && rssSlope > RSS_SLOPE_LIMIT) {
    failures.push(
      `RSS slope ${rssSlope.toFixed(2)} MB/min over final ${slopeWindow}min exceeds ${RSS_SLOPE_LIMIT}`,
    );
  }

  // p95 late-window vs early-window (minute ~55 vs ~5, scaled by duration).
  const early = nearest(samples, MINUTES * (5 / 60));
  const late = nearest(samples, MINUTES * (55 / 60));
  if (early && late && early.p95ms > 0 && late.p95ms > P95_GROWTH_LIMIT * early.p95ms) {
    failures.push(
      `p95 grew ${early.p95ms}ms→${late.p95ms}ms (> ${P95_GROWTH_LIMIT}× the early window)`,
    );
  }

  if (unhandled > 0) failures.push(`${unhandled} unhandled rejection(s) during the soak`);

  console.log(
    `[soak] done: ${samples.length} samples, RSS slope ${rssSlope.toFixed(2)} MB/min, ` +
      `p95 ${early?.p95ms ?? '?'}→${late?.p95ms ?? '?'}ms, ${unhandled} unhandled → ${OUT}`,
  );
  if (failures.length > 0) {
    console.error('[soak] SOAK FAILED:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('[soak] ✓ soak passed');
}

await main();
