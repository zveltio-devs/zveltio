/**
 * Latency vs concurrency, against a live engine.
 *
 * Usage:
 *   bun run scripts/bench-concurrency.ts <url> <cookie> [levels] [n] [extraHeader]
 *
 * Measured 2026-08-26 against /api/me — the lightest authenticated route there
 * is — on one machine, one engine, DB_POOL_MAX=10:
 *
 *   without a tenant header (no request transaction):
 *     c=20 → 29ms p50, 670 req/s, 0 errors
 *     c=30 → 44ms p50, 683 req/s, 0 errors
 *   with `x-tenant-slug` (tenantMiddleware opens a transaction for the request):
 *     c=20 → p99 10.4s, 22 req/s
 *     c=30 → p95 23.8s,  5 req/s, 36 failures
 *
 * Same binary, same pool, same query. One header. That is the whole finding:
 * the ceiling is the transaction that spans the request, pinning one pooled
 * connection from BEGIN to response. Raising DB_POOL_MAX to 40 moves the cliff
 * out past c=80 — which is why the number looks like a fix and is not one: each
 * engine instance holds its own pool against one `max_connections`.
 *
 * The point is NOT throughput. It is the SHAPE: if p50 is flat at c=1 and the
 * curve breaks at some c, the cost is contention for something scarce — a
 * pooled connection — not the work the handler does. A slow handler degrades
 * smoothly; a saturated pool degrades off a cliff and starts refusing.
 */
const URL_ = process.argv[2] ?? 'http://127.0.0.1:3400/api/me';
const COOKIE = process.argv[3] ?? '';
const LEVELS = (process.argv[4] ?? '1,2,5,10,15,20,30,50').split(',').map(Number);
const PER_LEVEL = Number(process.argv[5] ?? 200);
// Optional extra header, e.g. 'x-tenant-slug: default' — the switch that decides
// whether tenantMiddleware opens a transaction for the request or not.
const EXTRA = process.argv[6] ?? '';

async function once(): Promise<{ ms: number; status: number }> {
  const t = performance.now();
  try {
    const headers: Record<string, string> = {};
    if (COOKIE) headers.cookie = COOKIE;
    if (EXTRA) {
      const i = EXTRA.indexOf(':');
      headers[EXTRA.slice(0, i).trim()] = EXTRA.slice(i + 1).trim();
    }
    const res = await fetch(URL_, { headers });
    await res.text();
    return { ms: performance.now() - t, status: res.status };
  } catch {
    return { ms: performance.now() - t, status: 0 };
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Warm-up: first requests pay for lazy init and would skew c=1.
for (let i = 0; i < 20; i++) await once();

console.log('  conc |   n |   p50 |   p95 |   p99 |   max | non-200');
console.log('  -----+-----+-------+-------+-------+-------+--------');
for (const c of LEVELS) {
  const perWorker = Math.max(1, Math.round(PER_LEVEL / c));
  const started = performance.now();
  const results = (
    await Promise.all(
      Array.from({ length: c }, async () => {
        const out: { ms: number; status: number }[] = [];
        for (let i = 0; i < perWorker; i++) out.push(await once());
        return out;
      }),
    )
  ).flat();
  const wall = performance.now() - started;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const bad = results.filter((r) => r.status !== 200);
  const codes = [...new Set(bad.map((r) => r.status))].join(',') || '—';
  console.log(
    `  ${String(c).padStart(4)} | ${String(results.length).padStart(3)} |` +
      ` ${pct(lat, 50).toFixed(0).padStart(5)} | ${pct(lat, 95).toFixed(0).padStart(5)} |` +
      ` ${pct(lat, 99).toFixed(0).padStart(5)} | ${lat[lat.length - 1].toFixed(0).padStart(5)} |` +
      ` ${String(bad.length).padStart(3)} ${codes}` +
      `   (${(results.length / (wall / 1000)).toFixed(0)} req/s)`,
  );
}
