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

## Small VPS probe (`small-vps*.sh|ts`)

The compiled binary on the VM, not the harness: one engine process in
`systemd-run --scope -p AllowedCPUs=0 -p MemoryMax=1G`, the 37 declared-model
first-party extensions (`ext-first-party-as-worker.test.ts` `LOADS`; the four `"*"`
extensions cannot run isolated at all) booted from `ZVELTIO_EXTENSIONS`, registry
rows enabling them. Runner units get the same CPU pin from a drop-in.

1. `small-vps-prep.sh`: two trees, `ext-inline` (registry-signed) and `ext-worker`
   (`engine.isolation: worker`, signed by `small-vps-sign.ts`).
2. `small-vps.sh setup`, then `warm-inline`: first boots (migrations, core packages),
   the member and its grants.
3. `small-vps.sh alone|inline|runner|runner-load`, then `small-vps-report.ts <outdir>`.

`runner` samples every unit running, then masks and stops every unit (the idle
stop does not exist yet; without the mask the engine respawns them in 1 s) and
samples again. Memory is RSS and PSS from `smaps_rollup`, read with sudo by the
operator's driver for the scope and every `zveltio-ext-runner@*` unit.
`runner-load` runs `createInvoice` (3 lines) at concurrency 5 for two minutes from
CPU 1, over HTTP, and counts `extension.busy`.

## Fail-alone probe (`failalone*.sh|ts`, `probe-bad-ext/`)

Three signed test extensions (declared model, one action `misbehave`): `loop`
(`while (true) {}`), `leak` (16 MB every 5 ms, never answers), `crash`
(`process.exit(1)`), plus `plain` (a collection and a `ping`). Each run is a fresh
engine (compiled beta.132, `NODE_ENV=production`, scope `MemoryMax=1G`) loading
`finance/invoicing`, `plain` and one bad extension, on the runner (operator-signed,
`engine.isolation: worker`) or inline. **Inline needs a catalog name** (the engine
refuses an unknown name inline: `load-phases.ts`), so the inline trees carry the same
code under the names of first-party extensions the bench DB never loaded
(`operations/traceability`, `developer/api-docs`, `integrations/migrators`,
`analytics/quality`), registry-signed with a throwaway key.

Load (`failalone-load.ts`, one core): data API on a plain collection, GET list and POST
alternating at concurrency 5, plus `createInvoice` every 200 ms; 30 s baseline, then the bad
action once a second. `failalone-prep.sh` builds the trees, `failalone.sh <runner|inline>
<loop|leak|crash>` runs one, `failalone-report.ts results/failalone` prints the table.
The load generator is unpinned on a 2 vCPU box with PG, the engine and the runner units.
First time a collection is granted, the engine takes ~30 s to honour it (`GRANT_WAIT=35`).
`results/failalone` has logs (engine, units, request logs gzipped); `results/failalone-cpuquota50`
is the loop with `CPUQuota=50%` on the runner units.

## Restrictive PaaS probe (`paas.sh`, `paas-calls.ts`)

The `standalone` target of the Dockerfile (built here with the legacy builder:
`--platform=$BUILDPLATFORM` removed, nothing else), loaded on the VM, one container,
host network, `--memory 1g`, `finance/invoicing` (registry-signed, inline) and
`probe/plain` (operator-signed, worker) in `/data/extensions`. States: `control`
(docker defaults), `strict` (`--cap-drop ALL --security-opt no-new-privileges`),
`strict-chown` (strict plus CHOWN, DAC_OVERRIDE, FOWNER) and `strict-user` (strict
plus `--user 100:101`). `results/paas` has the state, log, `/health` and calls of each.
