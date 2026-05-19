# Zveltio benchmarks

A reproducible performance suite. Numbers we can quote, that anyone can re-run.

## What it measures

| Bench              | What                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| REST CRUD          | Single-record `POST`/`GET`/`PATCH`/`DELETE` latency on a fresh collection |
| List + pagination  | Page-1 vs deep-offset vs cursor pagination across 5k rows             |
| Realtime WS        | Latency from `POST /api/data/...` → WebSocket event delivery          |
| Cold-start         | `bun run start` → `/api/health` 200 (opt-in)                          |

For each surface we report `min / p50 / p95 / p99 / mean ± stddev` plus throughput.

## Method

- **Timing**: `performance.now()` wall-clock around each request, *inside* the
  Bun runtime. No external load generator — we measure what a TypeScript SDK
  consumer would actually feel.
- **Percentile algorithm**: nearest-rank (R-2). Same as wrk, hey, k6. Easier
  to reproduce across runs than interpolated quantiles.
- **Warmup**: each phase runs `BENCH_WARMUP` throwaway requests before measuring.
  This warms Bun's JIT, the JDBC pool, and any extension caches.
- **Isolation**: every bench creates a uniquely-named collection
  (`bench_crud_<random hex>`, etc.) and drops it after, so concurrent runs
  don't collide and tear-down is clean.
- **Defaults**: 200 iterations, concurrency=1. Override via env.

## Quickstart

```sh
# 1. Start the engine (separately, in another terminal)
cd packages/engine && bun run dev

# 2. Run the bench against it
bun run bench/runner.ts

# Result: bench/results/zveltio-<timestamp>.json (also overwrites latest.json)
```

## Env vars

| Var                  | Default                         | Notes                              |
| -------------------- | ------------------------------- | ---------------------------------- |
| `BENCH_BASE_URL`     | `http://localhost:3000`         | Engine endpoint                    |
| `BENCH_EMAIL`        | `admin@example.com`             | Login for API token                |
| `BENCH_PASSWORD`     | `admin1234`                     | Login for API token                |
| `BENCH_WARMUP`       | `20`                            | Throwaway iterations per phase     |
| `BENCH_ITERATIONS`   | `200`                           | Measured iterations per phase      |
| `BENCH_CONCURRENCY`  | `1`                             | Parallel in-flight requests        |
| `BENCH_TAG`          | variant name                    | Prefix for output filename         |
| `BENCH_SKIP`         | (empty)                         | Comma list: `crud,list,realtime,coldstart` |
| `BENCH_COLDSTART`    | `0`                             | Set to `1` to run cold-start bench |
| `BENCH_SESSION_COOKIE` | (empty)                       | Required for realtime bench (WS auth) |
| `BENCH_VARIANT`      | `zveltio`                       | Set `pocketbase` for comparison    |

## Comparison vs Pocketbase

See `bench/compare/pocketbase/setup.md` for the one-time setup, then:

```sh
docker compose -f bench/compare/pocketbase/docker-compose.yml up -d

BENCH_TAG=zveltio bun run bench/runner.ts
BENCH_VARIANT=pocketbase BENCH_BASE_URL=http://localhost:8090 \
  BENCH_EMAIL=admin@example.com BENCH_PASSWORD=admin12345678 \
  BENCH_TAG=pocketbase bun run bench/runner.ts
```

Both engines run with default settings — we're measuring out-of-the-box
performance, which is what users feel.

## Interpreting results

- **p99 > 10× p50** suggests GC pressure, lock contention, or a noisy
  neighbour. Re-run with `BENCH_CONCURRENCY=1` to rule out client-side
  saturation.
- **Throughput plateau** as you raise concurrency means you've hit the
  engine's per-process ceiling. Real production runs behind a load balancer
  with N workers will scale roughly linearly until DB-bound.
- **Deep-page p95 >> first-page p95** is expected for offset pagination
  (Postgres reads + discards N rows). Cursor pagination should be flat.
  If it isn't, the cursor index is missing.

## What we DON'T measure (yet)

- Multi-tenant noisy-neighbour isolation
- Hot-reload / extension activation overhead
- AI extension semantic-search latency (depends on pgvector + model)
- Realtime under load (1000+ concurrent WS clients)

Tracked in `docs/TECHNICAL-GAPS.md` § 3 (Performance & Scale).
