# Benchmarks

Measured numbers for the Zveltio engine, and the suite that produces them.
Every figure on this page comes from `bench/` in this repository and can be
re-run with the commands below.

## Latest run (2026-09-30, master `710d7e76`)

One developer machine, not a dedicated benchmark host:

| Component | Spec |
|---|---|
| CPU | 4 vCPU Intel Xeon Gold 5317 |
| RAM | 8 GB |
| PostgreSQL | 18.6, same host, default config |
| Bun | 1.3.14 |
| Valkey | none (direct database path) |
| Engine | `NODE_ENV=test` (as the CI perf job; disables rate limiting), single process |

`bench/runner.ts`, 50 warm-up requests, 500 measured requests per row,
authenticated as a `god` user on a fresh collection. Latency is wall-clock
from the client, nearest-rank percentiles.

**Sequential (concurrency 1):**

| Operation | p50 | p95 | p99 | ops/s |
|---|---|---|---|---|
| `POST` create | 4.9 ms | 8.7 ms | 11.5 ms | 182 |
| `GET` by id | 2.5 ms | 5.3 ms | 8.3 ms | 333 |
| `PATCH` | 4.4 ms | 8.9 ms | 12.8 ms | 199 |
| `DELETE` | 4.1 ms | 7.1 ms | 10.2 ms | 218 |
| List, page 1 (5k rows) | 4.3 ms | 6.7 ms | 9.1 ms | 210 |
| List, page 250 (offset) | 4.8 ms | 7.7 ms | 9.9 ms | 187 |
| List, cursor | 3.7 ms | 6.2 ms | 8.4 ms | 239 |
| Realtime: `POST` → WebSocket event | 3.4 ms | 5.5 ms | 7.2 ms | — (n=50) |

**Concurrency 10 (CRUD only; the list and realtime benches run sequentially):**

| Operation | p50 | p95 | p99 | ops/s |
|---|---|---|---|---|
| `POST` create | 27.0 ms | 38.3 ms | 42.2 ms | 360 |
| `GET` by id | 16.2 ms | 23.1 ms | 26.5 ms | 595 |
| `PATCH` | 25.8 ms | 33.2 ms | 37.4 ms | 379 |
| `DELETE` | 26.0 ms | 36.4 ms | 43.5 ms | 370 |

Throughput roughly doubles from 1 to 10 clients on 4 vCPU while latency
grows about fivefold: the host is saturated, engine and database share it.
Treat these as the shape of the curve on small hardware, not as a ceiling.

Not measured on this run: sign-in, edge functions under load, memory over
time, cold start. See [what is not published](#what-is-not-published).

## Reproducing

```bash
# 1. A database with the extensions the engine needs
createdb zveltio_bench
psql -d zveltio_bench -c 'CREATE EXTENSION pg_trgm; CREATE EXTENSION vector;'
DATABASE_URL=postgresql://localhost/zveltio_bench bun packages/engine/src/db/migrate.ts

# 2. The engine
DATABASE_URL=postgresql://localhost/zveltio_bench \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
NODE_ENV=test ZVELTIO_REGISTRATION_ENABLED=1 \
bun packages/engine/src/index.ts &

# 3. A bench user with the god role
curl -sf -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"admin1234","name":"Admin"}'
psql -d zveltio_bench -c "UPDATE \"user\" SET role = 'god' WHERE email = 'admin@example.com'"

# 4. The suite (crud, list, realtime; cold start with BENCH_COLDSTART=1)
BENCH_ITERATIONS=500 BENCH_WARMUP=50 BENCH_CONCURRENCY=1 bun run bench/runner.ts
```

Results go to `bench/results/latest.json`. `bench/README.md` lists every
knob (`BENCH_CONCURRENCY`, `BENCH_SKIP`, `BENCH_VARIANT`, …).

### CI regression check

The `Perf Smoke` job in `.github/workflows/ci.yml` runs `bench/ci-check.ts`
on every PR. It fails only on a catastrophic regression — a p95 roughly ten
times over a baseline — because shared CI runners are too noisy to catch
drift. The budgets and the reasoning live in the header of `ci-check.ts`.

## Workload notes

### Edge functions: one runner, and what it costs

Edge functions run in a fresh Bun process per invocation: OS-process
isolation, a kernel memory ceiling, a minimal environment.

**Measured per INVOCATION, warmed, median of 15 on one machine:**

| runner | median | p90 |
| --- | --- | --- |
| subprocess, spawned on demand | 42.6 ms | 44.6 ms |
| subprocess, pre-spawned | 13.4 ms | — |
| in-process Worker (removed) | 31.8 ms | 37.1 ms |

The Worker mode was removed rather than tuned. It could not be given a
memory ceiling — Bun ignores a Worker's `resourceLimits`, measured: one
capped at 64 MB allocated 4 GB and reported success — and it was not
the fast option either, once a pre-spawned process was measured against
it.

This section previously said "~30 ms startup" against "~1 ms startup"
and called the subprocess "roughly 40× slower in throughput". Those
figures describe RUNNER STARTUP in isolation, not a call: an invocation
pays transpilation, compilation, the globals lockdown and a round trip
on either runner. Quoting a startup cost as if it were request latency
made the safe default look forty times more expensive than it is —
which is the kind of number that gets a boundary switched off.

This page said the opposite until 2026-09-03 — it named `worker` as the
default, contradicting the code (`lib/edge-function-runner.ts`), the
README, AGENTS.md and SECURITY.md. It is the public document, so an
operator reading it would have believed untrusted code ran in-process by
default, and would have sized capacity against the wrong startup cost.

## What is not published

- **Sign-in throughput, edge functions under load, memory over time, cold
  start.** The suite has a cold-start bench (`BENCH_COLDSTART=1`) and a soak
  driver (`bench/soak.ts`, RSS slope and late-window p95); their results are
  not on this page yet.
- **Multi-tenant overhead.** Not measured separately.
- **Engine and database on separate hosts.** Network round-trips dominate and
  vary by topology.
- **Valkey enabled.** Cached reads would be faster; the table above is the
  direct database path.

Numbers on this page were previously labelled "alpha.99" and described a
dedicated host, load generator and scenario files that are not in this
repository. They were replaced on 2026-09-30 by the run above.
