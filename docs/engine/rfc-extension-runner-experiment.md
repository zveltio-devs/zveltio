# Experiment: first-party extensions out of process

Companion to [rfc-extension-runner.md](rfc-extension-runner.md), decision 5. The
question: should first-party extensions run on the extension runner by default,
with an inline exception list? Three first-party extensions that use neither
`ctx.internals` nor in-transaction hooks — the easiest candidates of the 55 —
were run inline and out of process against a real engine.

**Result:** none works out of process on today's engine; with a throwaway shim they
run at ~2x latency and +50–65 MB RSS each, and multi-statement writes lose
atomicity (a burned invoice number, an orphan contact). First-party extensions stay
inline; the gaps found are the worker contract's, so third-party extensions hit
them too — see the RFC's migration plan, steps 6–8.


Date 2026-10-09. engine origin/master 0330aa92, extensions origin/master 1f89151.
Machine: Linux, Bun 1.3.14, PostgreSQL 18.6 local, no Valkey (NODE_ENV=test; caches
hit the DB on every request equally in every mode). Single client, concurrency 1.

## Modes

| Mode | What | Switch |
|---|---|---|
| A | inline, as today | manifests unchanged |
| B0 | out of process, engine unmodified | `"isolation": "worker"` in each manifest's `engine` block (what `extension pack` without `--first-party` writes; bundles already `bundled: true`) + `ZVELTIO_EXT_TRANSPORT=process` |
| B (process) | B0 + experiment shim (below) | same + shim |
| B (runner) | B0 + shim, on the container runner: overlay's `ext-runner` service settings (root + SETUID/SETGID/KILL, `network_mode: none`, read-only, 1g, pids 256), test-overlay image (bun:1.3-alpine + setpriv), engine on the host speaking to its socket | `ZVELTIO_EXT_TRANSPORT=runner ZVELTIO_EXT_RUNNER_SOCKET=…`; each extension ran under uid 2000xx (verified with `docker top`) |

The shim (`scratch/exp/shim.patch`, ~90 lines, NOT for merge) gives the worker the ctx
the three extensions use: a Kysely instance over `db:query` (transactions are no-ops —
the bridge refuses BEGIN/COMMIT/SAVEPOINT), JS-array→PG-array param encoding,
`auth.api.getSession`, `checkPermission`, `events.emit/emitAsync` and `services.get(name)`
as host calls through `service:call` (`__engine.*`), and `config.vars` in `init`. Child env
also gets `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` (the mocked provider; operator egress).
It is the minimum to make B measurable, i.e. a lower bound on the engine work.

## 1. Does it work

B0 (engine as on master), all three:
- **sms**: refused at load. `worker "sms" init failed: undefined is not an object (evaluating 'ctx.config.vars')` — worker ctx has no `config`. Every /ext/sms route 404.
- **crm**: loads (24 routes) but `register()` logs `CRM adopt 'contacts|organizations|transactions' failed: undefined is not an object (evaluating 'ddl.tableExists')` (no `ctx.DDLManager`: Studio metadata adoption silently skipped). Every route 500: `TypeError: undefined is not an object (evaluating 'auth.api')` (no `ctx.auth`).
- **finance/invoicing**: loads (43 routes), every route 500, same `auth.api` TypeError.
- Behind those, every handler would fail next on `sql\`…\`.execute(ctx.db)` / `db.selectFrom` (worker `ctx.db` is `{ query(sql, …params) }`, not Kysely), `ctx.checkPermission` (absent), `ctx.events` (absent).
- `ctx.services.get(name)` has a different contract in the worker: it CALLS the service (`get(name, args)` → Promise) instead of returning the impl. invoicing does `const crmLookup = services.get('crm.contacts.lookup'); if (crmLookup) await crmLookup(id)` → `crmLookup is not a function`, plus a dangling call.
- Worker errors reach the engine log as `[worker:crm] {}` (Error objects do not survive the log frame).

B with the shim (process and runner), remaining failures:
- **Array parameters**: before the shim encoded them, `POST /crm/contacts` and `/organizations` 500 `malformed array literal: ""` — the bridge passes JS arrays raw to `unsafe()`; the inline BunSQL dialect converts them to `{…}` literals (bun-sql-dialect.ts:596).
- **SQLSTATE lost**: `POST /invoicing/series` duplicate → A 400 "Series already exists", B 500. The bridge rejects with `new Error(res.error)`; `errno` 23505 is dropped, so `isUniqueViolation()` is false.
- **Egress (runner only)**: `POST /sms/send` → 500 `Unable to connect. Is the computer able to access the url?`, 5 s per attempt (runner has `network_mode: none`, as the overlay ships). Message recorded `status=failed`. Expected until an operator grants egress; compose has no per-extension egress.
- Not covered by the shim, would fail: crm adopt (`DDLManager`), `numAffectedRows` (bridge returns rows only: Kysely UPDATE/DELETE without RETURNING reports 0), `events.on` subscriptions, API-key principals (`apiKeyRoutes` in invoicing; `getSession` is cookie-based), `reqDb/adminDb/queryAlter/entityAccess/describeDenial/onHealthCheck`, field types, cron, cleanup hook (load.ts says so).
- Worker SQL policy refused nothing these three routes issue (tables are user `zvd_*` + own `zv_sms_*`).

## 2. Latency (ms, warm, sequential, 200 requests/route after 20 warm-ups)

A and B(process) = mean of two runs (each from a fresh boot); B(runner) one run.

| route | A p50 | A p95 | B-process p50 | B-process p95 | B-runner p50 | B-runner p95 |
|---|---|---|---|---|---|---|
| sms POST /send (mock Twilio) | 6.3 | 10.6 | 11.0 | 18.1 | 5014 (egress denied) | 5024 |
| sms GET /messages | 3.7 | 7.2 | 7.1 | 11.8 | 10.0 | 13.6 |
| crm POST /contacts | 4.0 | 7.7 | 7.1 | 11.5 | 9.2 | 12.8 |
| crm GET /contacts | 4.6 | 7.4 | 8.7 | 13.9 | 11.2 | 13.2 |
| crm GET /contacts/:id | 3.1 | 5.5 | 5.8 | 10.2 | 7.0 | 9.9 |
| crm PATCH /contacts/:id | 3.8 | 6.7 | 6.4 | 11.6 | 7.8 | 11.7 |
| crm DELETE /contacts/:id | 3.8 | 6.3 | 8.0 | 12.4 | 9.8 | 12.9 |
| inv POST /invoices | 7.1 | 9.7 | 16.8 | 27.4 | 19.7 | 25.1 |
| inv GET /invoices | 8.1 | 10.9 | 13.7 | 17.0 | 17.5 | 22.9 |
| inv GET /invoices/:id | 3.4 | 5.7 | 9.2 | 13.7 | 9.2 | 12.2 |
| inv PATCH /invoices/:id | 2.8 | 4.9 | 6.6 | 9.9 | 6.5 | 9.4 |
| inv POST /invoices/:id/send | 2.7 | 5.0 | 6.7 | 9.5 | 7.4 | 14.8 |

Raw p50 per run (A2 Am B2 Bm R1): sms send 6.75 5.76 10.96 11.01 5014; crm GET list 4.59 4.62 8.95 8.41 11.19; inv POST 6.99 7.13 16.45 17.19 19.72 (others in result-*.json).
B is 1.8–2.7x A at p50 (+3 to +10 ms); the runner adds ~1–3 ms over the process transport.
Why (from the code path, not measured separately): every bridged statement is its own
host transaction on a reserved connection — BEGIN, SET LOCAL statement_timeout, role
lookup SELECT, SET LOCAL ROLE, set_config(10 GUCs), the statement, COMMIT — i.e. 7
round-trips where inline runs 1 inside the request transaction; plus two extra IPC
round-trips per request for getSession and checkPermission.
Note: B DBs held more invoices than A's (runs accumulate); lists are LIMIT 50.

Cold first request after boot + sign-in (ms; A1 Am | B2 Bm | R1):
sms templates.create 19 18 | 39 35 | 43; crm org.create 23 18 | 30 31 | 39;
inv company.get 16 11 | 19 25 | 25; inv create 26 22 | 39 37 | 48.
Boot to /health: A ≈2.07 s, B process ≈2.58 s, B runner ≈2.58 s (0.5 s poll granularity).
Each worker extension is spawned TWICE at boot (load into `_tempApp`, then `buildHonoApp`
re-registers; the first process is killed — runner uids 200000-2 died, 200003-5 served).

## 3. Memory (kB; one sample each; RSS / PSS from /proc/<pid>/smaps_rollup)

| | idle (10 s after boot) | after one bench run |
|---|---|---|
| A engine | RSS 187 856 / PSS 148 474 | RSS 281 576 / PSS 241 432 |
| B-process engine | 175 228 / 137 292 | 301 456 / 261 709 |
| B-process sms, crm, invoicing | 61 608 / 31 623; 63 576 / 32 885; 65 452 / 35 023 | 76 168 / 40 841; 73 224 / 39 594; 91 748 / 58 023 |
| B-process total | 365 864 / 236 823 | 542 596 / 400 167 |
| B-runner engine | 171 832 / 139 789 | 295 584 / 263 066 |
| B-runner container: runner + 3 ext (RSS via docker top) | 50 472 + 50 040 + 51 608 + 51 976; cgroup 74.3 MiB | 56 180 + 61 284 + 60 308 + 82 148; cgroup 102.2 MiB |

Moving the three out saves ~13–16 MB RSS in the engine at idle; each out-of-process
extension costs ~50–65 MB RSS (~32–35 MB PSS) idle, 60–92 MB RSS loaded, plus ~50 MB for
the runner. Engine growth under load (~+100 MB) is request handling, not extension code;
single-sample GC noise is ~±20 MB.

## 4. Transaction semantics — proven different

Case 1, invoicing: `POST /invoices` with `issue_date: "not-a-date"` (claimNumber UPDATE succeeds, the INSERT then fails 22007):
- A: 500, `zvd_document_series.next_number` 5 → 5 (rolled back).
- B-process: 500, 3 → 4 and 6 → 7; B-runner: 500, 452 → 453. The invoice number is burned: a permanent gap in a fiscal series — the exact defect `claimNumber`'s comment says the extension exists to prevent.

Case 2, crm: `POST /contacts` with a random `organization_id` (contact INSERT succeeds, the link INSERT fails on the FK):
- A: 500, 0 contact rows left. B-runner: 500, **1 orphan contact row left**.

Cause: the bridge runs each statement in its own transaction and refuses BEGIN/COMMIT/SAVEPOINT (`assertWorkerSqlAllowed`, checked); `db.transaction()` cannot be honoured, and the request transaction an inline extension joins does not exist on the worker side.

## 5. Other behaviour

- tenant_id and actor of the writes: identical. A and B both wrote `tenant_id = 00000000-…0001` and `created_by = <session user id>` on contacts and invoices; sms rows tenant-scoped the same. The bridge sets the tenant GUC + caller from the host's record.
- The bridge deliberately does not carry `rls_bypass` / `visible_tenants`: a god or multi-tenant caller that sees more than one tenant inline sees only the request tenant through a worker (not exercised; one tenant here).
- Audit: no per-write audit rows from extension routes in either mode (only `extension.loaded`; B0 also `extension.load_failed` for sms).
- Engine events: B0 has no `ctx.events`; with the shim `emit` is a fire-and-forget host call and `emitAsync` runs listeners in a separate transaction from the writes (inline, invoicing awaits `invoice.created` inside the request transaction on purpose). DB-level NOTIFY is unchanged.
- Errors: zod 400s pass through; unhandled errors come back as Hono's plain "Internal Server Error" (normalized to a problem 500 by the engine), not the engine's own onError mapping.

## Re-run

The scripts (bench, transaction cases, RSS sampler, mocked Twilio, runner compose
file, the shim patch) are in `zveltio-private/engine/experiments/ext-runner-2026-10-09/`
with the original re-run notes. The mocked provider's TLS material is not kept:
regenerate a CA and an `api.twilio.com` certificate for it.
