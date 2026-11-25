# ADR 0062 performance probe

`ext-perf.ts` measures `finance/invoicing` `createInvoice` (3 and 20 lines) as a
member through the engine's own `/ext/*` chain (session prefetch, tenant
middleware, auth gate), in one mode per engine process:

| mode | what runs |
|---|---|
| `inline` | the extension imported into the engine (`_setInlineForTests`) |
| `process` | signed worker, `ZVELTIO_EXT_TRANSPORT=process` (child of the engine) |
| `runner` | signed worker on the systemd runner (`zveltio-ext-runner@<instance>`) |

One mode per process: Hono cannot unmount inline routes, so a second mode in one
process silently measures inline twice. The script refuses a run whose mode is not
what was asked (worker present under inline, runner unit not active under `runner`).

Per process and per line count: 30 warm-ups, sequential n=300 (p50/p95), then
concurrency 10, n=500 (throughput, `extension.busy` refusals, other errors).
Then, for worker modes, `--cold N` (default 20) restarts: stop the worker (the
unit under `runner`), start it, serve the first action; the time runs from the
call that starts the unit to the first action's response. `runner` also records the
floor (`systemctl start` and the socket appearing, no engine around it). Memory
(RSS/PSS from `/proc/<pid>/smaps_rollup`) of the worker's processes idle and after
the run; under `runner` those run under another uid, so `ext-perf.sh` (the operator, with sudo)
reads them when the bench prints `@@CHECKPOINT <label>`; no root process reads anything another user can write.

`DB_POOL_MAX` comes from the environment: empty is the engine default (sized from
the server's `max_connections`), `40` and `10` explicit. The worker box limit is
pool/4.

## Run (on a box set up as in `scripts/ext-runner-systemd.sh`)

1. PostgreSQL 18 + pgvector + postgis; `scripts/bootstrap-db-role.sh <db> zveltio_app <pw>`.
2. Bun at `packageManager`; `bun install`; sibling `../zveltio-extensions` checkout.
3. `bun build --compile packages/engine/src/binary-entry.ts`, install it at
   `<dir>/zveltio`, `sudo <dir>/zveltio ext-runner setup --engine-user zveltio --dir <dir>`.
4. `bash packages/engine/scripts/bench/ext-perf.sh 2 /tmp/ext-perf` (rounds, out dir;
   edit `BENCH_DATABASE_URL`), then `bun packages/engine/scripts/bench/ext-perf-report.ts /tmp/ext-perf`.

The engine runs as the `zveltio` user (the runner answers only that uid),
`NODE_ENV=test` through the harness (`getTestApp`), `ZVELTIO_REGISTRATION_ENABLED=1`
for the member's sign-up.
