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

## 6. After RFC step 8 (one transaction per request), 2026-10-09

Re-run on the step-8 branch (base bef2bb12, steps 6 and 7 in), process transport,
same machine, no shim — steps 6 and 7 replaced it. "Before" is bef2bb12, "after"
the step-8 change, same database, two runs each, 200 requests per route.

What could run: **sms** loads. **crm** does not: its `register()` touches
`ctx.DDLManager`, which step 7 refuses at load, so case 2 (orphan contact) and
`txn2.ts` cannot be re-run against crm — the harness reproduces it instead
(`tests/harness/worker-request-transaction.test.ts`, red on bef2bb12, green after,
both transports, both drivers). **invoicing** loads, but no `POST /invoices`
succeeds out of process: before, `db.transaction()` is refused; after, it runs and
the route then fails at `ctx.events.emitAsync('record.created')`, which step 7
refuses a worker (it emits only its own `<name>.*` events). `sms POST /send` was
dropped from the bench: the child no longer gets the shim's `HTTPS_PROXY`, so it
would reach the real Twilio.

Case 1, invoicing, `issue_date: "not-a-date"`:
- before: 500, `next_number` 3 → 4 — burned. Over the bench's ~220 failing creates
  the series advanced to 224 with 0 invoices written.
- after: 500, 1 → 1 and 447 → 447 — rolled back. Over ~440 failing creates (each
  now writes the invoice and its lines, then fails at the event) not one number
  was burned and no invoice row was kept.

Database round-trips per request with N bridged statements (from the code path):
before 7·N (BEGIN, `statement_timeout`, role pick, `SET ROLE`, GUCs, the
statement, COMMIT — each on its own reserved connection, plus `DISCARD TEMP` where
the role kept TEMPORARY); after N + 6 on one connection, opened on the first
statement and ended with the response.

Latency, p50 / p95 ms (run 1 from a fresh boot; run 2 warm):

| route | before run 1 | before run 2 | after run 1 | after run 2 |
|---|---|---|---|---|
| sms GET /messages | 6.81 / 10.76 | 4.86 / 9.44 | 7.53 / 13.05 | 5.02 / 8.41 |
| inv GET /invoices | 5.93 / 9.42 | 4.15 / 8.42 | 4.92 / 9.81 | 4.37 / 8.48 |
| inv POST /invoices (500, see above) | 6.98 / 12.51 | 5.45 / 9.58 | 8.97 / 18.26 | 7.34 / 14.08 |

Reads are unchanged within run-to-run noise: on loopback a Postgres round-trip is
far cheaper than the worker IPC, so the removed per-statement overhead does not
show. The POST is not comparable — after, it does the inserts it never reached
before. RSS after step 8 (engine; sms and invoicing children): idle 158 104;
59 820, 64 048 kB, after two bench runs 271 908; 70 244, 90 400 kB — the same
range as §3.

Not run: the container runner (needs docker) and the bare-metal systemd runner;
nothing in step 8 is transport-specific (both transports are in the harness).

## 7. End to end on a live engine, 2026-10-10

After steps 6–9 and the host-owned `db.transaction()`: one third-party extension
through every path the RFC changed, over HTTP, against engines started for the
purpose — `packages/engine/src/tests/integration/extension-runner-e2e.integration.test.ts`,
run by the Integration Tests job (`bun run test:integration`).

Engine origin/master f49fa929 (ccd9d072 before #1017; both green). Bun 1.3.14,
PostgreSQL 18.6 local, Docker 29, no Valkey.

**What ran.** Two extensions written by the test, bundled,
`engine.isolation: "worker"`, in a catalogue (`<EXTENSIONS_DIR>/catalog.json`) as
`is_official: false`, `publisher_tier: "community"` — i.e. a third party.
Installed and enabled with `POST /api/marketplace/<name>/install|enable` as the god,
the dependency first; the files were already on disk (the air-gapped path), so no
download and no signature check ran. The main extension declares the other in
`dependencies`, has its own migration (`zv_<name>_notes`, `zv_<name>_log`), public
routes `/hook` and `/fwd` (`forwardCredentials: { "/fwd": ["authorization"] }`) and
four `apiKeyRoutes`. Three more are only enabled, to be refused: the dependency's
bundle without `isolation: "worker"`, and two workers that listen where they may
not. Callers: a member of the default tenant (session), an API key holding
`$ext:<name>` read+create, an anonymous sender. A tenant collection (RLS, created
through `/api/collections`) and the member's grants come from the API too.

**Legs.** The engine is started per leg (`bun src/index.ts`, NODE_ENV=test, own port,
`DB_POOL_MAX=10`) on TEST_DATABASE_URL — not the lane's engine on :3099, because the
driver, the transport, `EXTENSIONS_DIR` and the catalogue are boot settings.

| Leg | `ZVELTIO_DB_DRIVER` | Transport | How |
|---|---|---|---|
| bun:process | bun | process | nothing set: the default outside production |
| pg:process | pg | process | same |
| bun:runner | bun | runner | `ZVELTIO_EXT_TRANSPORT=runner` + socket; `zveltio ext-runner` in Docker as the release compose runs it: root, `ZVELTIO_EXT_RUNNER_UID_BASE=200000`, `--cap-drop ALL` + SETUID/SETGID/KILL (+ CHOWN for the socket directory), `--network none`, read-only bundle mount, engine on the host |
| pg:runner | pg | runner | same |

The runner legs name the transport because the engine is not in production; the
production default (`runner`) is pinned by `worker-extension-runner-default.test.ts`
and booted against a runner by the release smoke. Without Docker the runner legs
are skipped by name; with `CI` set the file fails instead.

**Results: 53/53 on all four legs, 37 s** (13 tests a leg plus the Docker check; 20 s
before the restart was added). The full integration lane, run as CI runs it (engine
on :3099, 38 files): 229 pass, 33 skip (other suites' opt-ins), 0 fail.

| Group | Asserted (every leg) |
|---|---|
| Third party | both workers install 200 and enable `success: true`; the non-worker twin is refused 422, "must run in worker isolation" |
| Out of process | the extension's pid is not the engine's; on the runner its uid is ≥ 200000 (on `process` it is the engine's — no boundary, by design) |
| Restart | after a restart the enabled extensions load at boot, on the same transport, and answer |
| Auth | `c.get('user')` and `ctx.auth.api.getSession()` are the member; a key is `apikey:<id>` with no session; a key on a route not in `apiKeyRoutes` is 403 |
| checkPermission | read true, delete false, for session and key; asked about the god by id: false |
| CRUD via `ctx.db` | Kysely insert/select (text[] round trip) on its own table as session and as key; insert/select/update/delete with affected-row counts on the tenant collection |
| Request transaction | a rolled-back `db.transaction()` (savepoint) keeps the outer write; a handler that throws answers 500 and keeps nothing |
| Host-owned transaction | in `register()`, a `setTimeout` from it, and an event delivery: the committing callback's row stays, the throwing one's is gone |
| Events | `emitAsync('<own>.ping')` reaches its own listener; the dependency's `<dep>.tick` reaches it; `record.created` is refused ("may not emit"); a listener on an undeclared extension's event or on `record.created` fails the enable (422, "may not listen to") |
| Services | `<dep>.echo` (declared) answers; `<dep>.squat` registered by the main extension is refused by the host, so it is "not found"; the dependency calling `<main>.double` (undeclared) is refused, "declare … in its manifest dependencies" |
| Credentials | `/hook` sees no `cookie`, `authorization`, `proxy-authorization`, `x-api-key`, and does see `stripe-signature`; `/fwd` sees `authorization` only |
| Lapsed member | in force: reads 2, inserts; with every assignment past `valid_to`: reads 0, update/delete touch 0, insert refused by the policy (SQLSTATE 42501), the table keeps its 2 rows and no new one |

**Every group bites.** Each guard broken in the engine (or the fixture), one leg run,
then restored — each run failed exactly the group named:

| Break | Leg | Failed |
|---|---|---|
| `enforcePublisherTier` lets every tier inline | bun:process | Third party |
| runner leg started without the runner transport | pg:runner | Out of process |
| proxy sends `user: undefined` | bun:process | Auth, checkPermission |
| proxy's `session` answers null | bun:process | Auth |
| `checkPermission` drops `a === who` | bun:process | checkPermission |
| bridge drops the affected-row `count` | pg:process | CRUD |
| bridge skips `encodeArrayParams` | bun:process | CRUD (on pg nothing: node-postgres encodes arrays itself) |
| savepoint rollback skips `ROLLBACK TO` | bun:process | Request transaction |
| request commits although the handler threw | pg:process | Request transaction |
| host-owned transaction commits on `rollback` | bun:process | Host-owned transaction |
| `refuseEvent` lets any emit through | bun:process | Events (emit) |
| `refuseEvent` lets any listener through | bun:process | Events (listen) |
| host never subscribes a worker listener | bun:process | Events, Host-owned transaction (event) |
| `serviceCallRefusal` returns null | bun:process | Services (undeclared) |
| `serviceRegisterRefusal` returns null | bun:process | Services (squat) |
| `workerRequestHeaders` strips nothing | bun:runner | Credentials |
| `forwardCredentials` ignored | bun:process | Credentials (`/fwd`) |
| bridge does not carry the lapsed caller's NO_UNITS | pg:process | Lapsed member (read 2; insert kept, and `/touch` deleted both rows) |
| registry row disabled before the restart | bun:runner | Restart |

**Defects found in the engine: none.** Traps met on the way (all in the test):

- the `oven/bun` image's workdir `/home/bun/app` is closed to a root without
  `CAP_DAC_*`; the runner's own `Bun.spawnSync(['chmod', …])` then fails with
  EACCES before it listens. `--workdir /` fixes it (the release image is unaffected);
- the runner refuses a socket directory that is not root's 0755 (`closeSharedDirs`):
  a host bind mount is chowned inside the container, and handed back before removal;
- a fresh pool per leg beside four engines ran PostgreSQL out of connections:
  autosizing gave each 60 of `max_connections = 200` (it assumes one instance
  unless `ZVELTIO_INSTANCES` says otherwise), and `Bun.SQL` opens its whole pool
  on the first query — it has no minimum, so the engine cannot open fewer
  (the `pg` driver opens on demand); the file shares one pool;
- dropping a collection with SQL leaves its `zvd_permissions` rows (the role defaults
  seeded on create and the member's grants); the file deletes them, and the two
  accounts. A full run leaves no row, role or table behind.

**Not covered:** the bare-metal systemd runner (`ext-runner-systemd.sh` checks its
isolation, not the `ctx` contract); a download from a registry with its signature
check; a tenant other than the default; egress; the production default end to end
on a live engine with this contract (only `hello-ext-worker`'s health route in the
release smoke).

## Re-run

The scripts (bench, transaction cases, RSS sampler, mocked Twilio, runner compose
file, the shim patch) are in `zveltio-private/engine/experiments/ext-runner-2026-10-09/`
with the original re-run notes. The mocked provider's TLS material is not kept:
regenerate a CA and an `api.twilio.com` certificate for it.
