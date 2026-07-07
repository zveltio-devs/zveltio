# Degradation Matrix — what keeps working when a dependency is down

Real production has flaky dependencies. This document is the **operator's map of
which dependencies are critical vs optional**, what the engine does when each is
unreachable, and which behaviours are already fault-tolerant vs still a hard
failure. It pairs with the deep-health endpoints (`/api/health/deep`,
`/api/health/<subsystem>`) — those tell you *what* is down; this tells you *what
that means*.

> Scope note: full graceful-degradation (in-memory cache fallback with re-sync,
> local write-queue for object storage) is TECHNICAL-GAPS §1.5 and a larger,
> subsystem-by-subsystem effort. This document is the **matrix + verification of
> the fallbacks that already exist today**; the "planned" rows are tracked there.

## Matrix

| Dependency | Critical? | When it's down | Behaviour today | Health check |
|---|---|---|---|---|
| **Postgres** | 🔴 critical | — | Engine can't serve. `/api/health/ready` → 503, pod pulled from the LB. A write killed mid-flight rolls back cleanly (no partial rows — see failure-injection tests). | `database`, `migrations` |
| **Valkey / cache** | 🟢 optional | Query cache + DB-driven rate-limit tiers | **Degrades, keeps serving.** `getCache()` returns `null` and every caller null-checks it → queries hit Postgres directly, rate-limiting falls back to defaults. `/ready` stays **200**; `/deep` shows `cache` ok with `configured:false` or an error but `criticalOk:true`. | `cache` |
| **Realtime bus** | 🟢 optional | Cross-instance broadcast / presence fan-out | **Degrades.** With no `VALKEY_URL` the bus is `pg-notify` (the default) or `none`; single-instance realtime still works in-process. A configured **Valkey** bus that's down is the only case flagged unhealthy. | `realtime` |
| **pg-boss queue** | 🟢 optional | Async DDL jobs (collection create/alter) | **Degrades.** Reads/writes to existing collections keep working; schema changes fail loudly until the worker is back. `/deep` → `degraded`. | `queue` |
| **Object storage (S3)** | 🟢 optional | File uploads/downloads | Uploads fail with a typed 5xx and **leave no orphan metadata row** (the row is written only after a successful PUT — see failure-injection S3). Existing local-served files unaffected. | `storage` |
| **AI / embedding provider** | 🟢 optional | Semantic search, AI hub | Provided by the `ai` extension; a provider 5xx is isolated to AI features. Provider rotation is partial (formalise in §1.5). | `ext:ai:*` (extension hook) |
| **An extension** | 🟢 optional | That extension's routes/features | A load failure is recorded (`lastLoadError`) and the extension is skipped; the rest of the engine serves normally. `/deep` `extensions` lists the failed ones. | `extensions` |

Legend: 🔴 critical = failing makes the engine **not ready** (LB should stop
routing). 🟢 optional = failing **degrades** a feature but the engine stays ready.

## Verified fallbacks (today)

- **Cache is optional** — `getCache()` returns `null` when `VALKEY_URL` is unset
  or the client failed; callers null-check, so a Valkey outage never fails a
  request. Confirmed by `/api/health/ready` staying 200 with no Valkey while
  `/api/health/deep` reports the cache state.
- **Realtime falls back to `pg-notify`** — `pickBus()` selects `PgNotifyRealtimeBus`
  when no `VALKEY_URL` is present and `NoopRealtimeBus` when there's no DB either,
  so realtime never hard-fails a deployment that simply hasn't configured Valkey.
- **No orphan/partial state under fault** — the failure-injection suite proves
  Postgres-drop-mid-write rolls back fully, and registry-down-mid-install /
  S3-down-mid-upload leave no orphan rows.

## Planned (TECHNICAL-GAPS §1.5)

- Cache: an **in-memory LRU fallback** that re-syncs on Valkey reconnect (today it
  simply bypasses the cache — correct but colder).
- Object storage: **queue writes locally** when S3 is unreachable and replay on
  reconnect (today an upload fails fast rather than buffering).
- AI providers: **formalise provider rotation** on 5xx.

## Probes to wire

- Kubernetes `livenessProbe` → `GET /api/health` (process up).
- Kubernetes `readinessProbe` → `GET /api/health/ready` (critical deps only).
- Dashboards / oncall → `GET /api/health/deep` (every subsystem + extension checks).

These are the defaults in `charts/zveltio/values.yaml`.
