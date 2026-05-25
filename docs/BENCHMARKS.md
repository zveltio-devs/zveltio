# Benchmarks

Reproducible performance measurements for the Zveltio engine. We
publish these so operators can size hardware honestly and so
contributors can detect performance regressions before they land on
master.

## TL;DR (alpha.99, single Bun process)

Measured on a dedicated runner: 8 vCPU (AMD EPYC 9354P), 16 GB RAM,
NVMe SSD, PostgreSQL 18 + pgvector on localhost, no Valkey. Each
scenario warms up for 5 s then samples for 30 s.

| Scenario | RPS | p50 | p95 | p99 | Notes |
|---|---|---|---|---|---|
| `GET /api/health` (cold) | 18,200 | 0.5 ms | 1.2 ms | 2.4 ms | No DB, no auth |
| `GET /api/data/zvd_contacts?limit=20` | 4,800 | 4.1 ms | 9.3 ms | 17 ms | Session cookie, RLS-on table |
| `POST /api/data/zvd_contacts` | 2,100 | 9.0 ms | 21 ms | 38 ms | Audit log + realtime broadcast |
| `GET /api/data/zvd_contacts/:id` | 6,400 | 3.0 ms | 7.1 ms | 13 ms | Hot index path |
| `POST /api/auth/sign-in/email` | 380 | 22 ms | 48 ms | 89 ms | argon2id verify dominates |
| WS subscribe + broadcast roundtrip | n/a | 1.8 ms | 4.2 ms | 8.5 ms | 100 concurrent subscribers, 1 publisher |
| Edge function (worker mode, hot) | 1,650 | 5.0 ms | 12 ms | 22 ms | 1 KB body, no fetch |
| Edge function (subprocess mode) | 38 | 25 ms | 41 ms | 68 ms | spawn-per-invocation cost |

**Memory**: RSS settles at ~720 MB after 30 min under mixed load.
**Cold start**: 1.2 s to first served request (binary mode), 2.4 s
(`bun run` mode).

These numbers are baselines, not aspirational. Beta releases bump
them by ≤ 20 % or the regression CI fails.

## Hardware + software baseline

The published numbers come from a CI-controlled environment:

| Component | Spec |
|---|---|
| CPU | 8 vCPU AMD EPYC 9354P |
| RAM | 16 GB |
| Disk | NVMe SSD (Hetzner Cloud CCX23 or equivalent) |
| OS | Ubuntu 24.04, kernel 6.8 |
| Bun | 1.3.x (whatever's in `bun.lock`) |
| PostgreSQL | 18.x with `pgvector` 0.7 |
| Valkey | none (excluded to measure DB-direct path) |
| Engine flags | `NODE_ENV=production`, default config |

Running on different hardware will give different absolute numbers.
What matters for regression catching is the SHAPE — p50/p95 ratio,
RPS plateaus under load, RSS growth slope.

## Reproducing the benchmarks

The `bench/` directory at the repo root holds the runner + scenarios.

```bash
# 1. Start a fresh PostgreSQL (or point at your own)
docker run -d --name bench-pg -e POSTGRES_PASSWORD=bench \
  -e POSTGRES_DB=zveltio -p 55432:5432 \
  pgvector/pgvector:pg18

# 2. Engine boot
cd packages/engine
ZVELTIO_DATABASE_URL=postgresql://postgres:bench@localhost:55432/zveltio \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32) \
bun run src/index.ts &

# 3. Wait for /api/health to come up
until curl -fsS http://localhost:3000/api/health >/dev/null; do sleep 0.5; done

# 4. Run the benchmark suite
cd ../../bench
bun run scenarios/data-list.ts   # GET /api/data/...
bun run scenarios/data-write.ts  # POST + PATCH + DELETE
bun run scenarios/auth.ts        # sign-in throughput
bun run scenarios/edge-fn.ts     # edge function invocations
bun run scenarios/realtime.ts    # WebSocket fan-out
```

Each scenario writes its own JSON report under `bench/results/`. Pass
`--format=md` for human-readable output.

### CI regression check

`bench/ci-check.ts` runs a SUBSET of the suite (the smoke scenarios)
and compares against a stored baseline in `bench/baseline.json`. If
any p95 regresses by more than the budget (default 20 %), CI fails.

```bash
# Update the baseline after intentional perf improvements:
bun bench/ci-check.ts --update-baseline

# CI mode (default — runs comparison, exits non-zero on regression):
bun bench/ci-check.ts
```

The smoke run is wired into `.github/workflows/ci.yml` so every PR
gets the regression check on a clean runner. The numbers from CI
runners are NOISIER than the dedicated benchmark host (shared
hardware), so the 20 % budget is set wide on purpose.

## Workload-specific notes

### Why no Valkey in the baseline

Valkey (query cache, rate-limit, presence) skews numbers in the
engine's favour for repeated reads. We measure the worst-case
direct-DB path so operators know what they're getting on a single
Postgres deployment. Enable Valkey and expect read-heavy scenarios
to roughly double (cache hit ratio dependent).

### Multi-tenant overhead

The numbers above are single-tenant (no `tenantMiddleware` active).
With tenant middleware on:

- Each request opens a transaction + `SET LOCAL` (≈ 0.4 ms overhead).
- FORCE RLS adds a per-row policy evaluation (≈ 0.1 ms per row).
- Net cost on `GET /api/data/zvd_contacts?limit=20`: p50 +0.6 ms,
  p95 +1.4 ms.

### Edge functions: worker vs subprocess

- `EDGE_SANDBOX_MODE=worker` (default): ~1 ms startup, in-process
  Worker thread. Use for admin-authored functions.
- `EDGE_SANDBOX_MODE=subprocess`: ~30 ms startup, OS-process
  isolation. Use for untrusted multi-tenant code. The subprocess
  path is roughly 40× slower in throughput because of `Bun.spawn`
  cost dominating the per-request budget.

## How we measure (methodology)

- **Loader**: `oha` for HTTP, `wscat`+homebrew loop for WS, a custom
  Bun script for edge-fn (it has to keep auth cookies).
- **Warm-up**: 5 s ignored before sampling begins. The first
  `bun install --frozen-lockfile` + engine boot does NOT count.
- **Sampling window**: 30 s per scenario. Reported percentiles are
  HdrHistogram (`oha --hist`).
- **Concurrency**: `oha -c 50 -z 30s` unless noted otherwise (50
  parallel connections).
- **Database state**: 10k rows in `zvd_contacts`, 100k rows in
  `zvd_orders`, indexes warmed via `pg_prewarm`. Cold-cache numbers
  are 2-3× slower; we publish the warm path because that's what
  production runs.

## Outstanding gaps

- Multi-host benchmarks (engine on host A, DB on host B over LAN):
  not yet published. Network adds 0.5-2 ms per round-trip; numbers
  vary too much by deployment topology to publish a single figure.
- Long-tail soak (24h): we run it before each release but don't
  publish — Grafana screenshots in the release notes.
- p99.9 numbers: HdrHistogram supports it, scenarios don't sample
  long enough to be statistically clean. 30 s × 4.8k RPS = 144k
  samples, fine for p99, noisy at p99.9.
