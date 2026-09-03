# System Architecture

How the pieces fit together, what runs in which process, and what happens to a
request between the socket and the database.

> Verified against `3.0.0-beta.64`. Where this document names a file, that file
> exists at that path — if it does not, this document is wrong and should be
> fixed rather than worked around.

---

## 1. The shape of the system

Zveltio is a **modular monolith**: one deployable process that contains all core
logic, with hard internal module boundaries and an out-of-process extension
runtime for untrusted code.

```
                    ┌──────────────────────────────────────┐
   browser ────────▶│  Engine  (Bun + Hono)  :3000         │
   SDK / API key    │                                      │
   WebSocket        │  ├── /admin      embedded Studio SPA  │
                    │  ├── /api/*      core REST + RPC      │
                    │  ├── /ext/<n>/*  extension routes     │
                    │  ├── /files/*    storage delivery     │
                    │  └── /fn/*       edge functions       │
                    └───┬───────────┬──────────┬────────────┘
                        │           │          │
             ┌──────────▼──┐  ┌─────▼─────┐  ┌─▼───────────────┐
             │ PostgreSQL  │  │  Valkey   │  │ Object storage  │
             │ 18+pgvector │  │  (cache,  │  │ local dir or    │
             │ (+ PgDog)   │  │  presence)│  │ S3 / SeaweedFS  │
             └─────────────┘  └───────────┘  └─────────────────┘

  separate processes, spawned by the engine:
    • worker-isolated extensions   (one process per extension)
    • edge function invocations    (one process per call, by default)
```

**Why a monolith.** The primary deployment is a single organisation
self-hosting on its own hardware — often one VPS. A single process means one
deployment, one log stream, one monitoring target, and no network hop between
subsystems. Modularity is enforced inside the process (see
`scripts/import-boundaries.ts`), not by splitting it into services.

### The four deployable surfaces

| Surface | Package | What it is |
|---|---|---|
| Engine | `packages/engine` | The server. Everything below is a client of it. |
| Studio | `packages/studio` | SvelteKit 5 admin SPA, built and embedded into the engine, served at `/admin`. |
| Client | `packages/client` | SvelteKit app for end users — public site, employee intranet, partner portal. |
| SDK / CLI | `packages/sdk`, `sdk-react`, `sdk-vue`, `packages/cli` | Typed client libraries and the `zveltio` binary. |

The engine is framework-agnostic: Studio and Client hold no privilege the API
does not grant them, and everything they do is available over REST/WebSocket.
**Studio runs with `ssr=false`.** Anything that looks like a server-side guard
in Studio code does not run — client-side checks are UX, the engine is the
boundary.

---

## 2. Boot sequence

`packages/engine/src/index.ts`, function `bootstrap()`. The order matters and is
deliberate — each step is placed so that a failure surfaces close to its cause.

1. **Telemetry** — `initTelemetry()`. No-op unless `OTEL_EXPORTER_OTLP_ENDPOINT`
   is set.
2. **Production config guards** — `assertProductionConfig()` from
   `lib/startup-guards.ts`. Runs *before* the database so a misconfigured deploy
   fails in a second rather than after migrations. This is what refuses a
   production boot without `VALKEY_URL`, with `CORS_ORIGINS=*`, or with the
   extension auth gate disabled.
3. **Database** — `initDatabase()`, then `reportConcurrencyCeiling(db)` prints
   the pool ceiling the instance actually runs under.
4. **Auto-migration** — `autoMigrate(db)` applies pending SQL migrations under a
   Postgres advisory lock, so concurrent replicas do not race. Opt out with
   `MIGRATIONS_AUTO=false`.
5. **Schema compatibility check** — exits if the schema is incompatible with the
   binary.
6. **Auth** — `initAuth(db)` (Better-Auth).
7. **Tenant manager** — `initTenantManager(db)`, before any route serves traffic.
8. **Permissions, RLS, validation** — `initPermissions()`, `initRls()`,
   `initValidationEngine()`, then `initRlsEnforcementRole()`.
9. **Boot repairs and sanity checks** — field-encryption check, unsigned-webhook
   repair, storage settings overlay from `zv_settings`, storage writability probe.
10. **Field types** — `registerCoreFieldTypes(fieldTypeRegistry)`.
11. **Extensions** — discovery, load, migration, route mounting.
12. **Background services** — event bus, realtime bus, cron runner, flow
    scheduler, webhook worker, garbage collector, memory monitor.

Steps 9 and 11 are the ones that surprise people: **extension migrations run
after the engine has started serving.** An extension performing `ALTER TABLE` on
a core table roughly a second after boot invalidates prepared statements held on
the pool — the historical source of `0A000` errors.

---

## 3. Request lifecycle

Middleware registration order in `index.ts` is the execution order. For a
request to `/api/*`:

| # | Middleware | Purpose |
|---|---|---|
| 1 | `trailingSlashRedirect` | `/api/thing/` → 308 → `/api/thing`. Intentional. |
| 2 | `logger()` | Request log line. |
| 3 | `problemOnError` / `problemNormalizer()` | Errors become RFC 7807 problem documents. |
| 4 | `enrichDenial(db)` | Turns a bare 403 into an explanation of which rule denied it. |
| 5 | `bodyLimit` | Size caps; separate ceiling for `/ext/*`. |
| 6 | `cors(corsOptions)` | Origins from `CORS_ORIGINS`. |
| 7 | `sessionPrefetch(auth)` | Resolves the session once per request. |
| 8 | `tenantMiddleware` | Resolves the tenant (header `x-tenant-slug`, host, or membership). |
| 9 | `tenantMembershipMiddleware` | Confirms the caller is a member of that tenant. |
| 10 | `extensionAuthGate(auth)` | `/ext/*` only — fail-closed session requirement. |
| 11 | `extRateLimit` | `/ext/*` rate limiting. |
| 12 | route handler | |

Inside a handler, tenant data is reached through a **request-scoped database
handle** (`createRequestScopedDb`), which opens a transaction, switches to the
unprivileged `zveltio_rls` role, and sets the per-transaction GUCs that the RLS
policies read. Bypassing that handle for tenant data is how cross-tenant leaks
happen; several gates exist solely to prevent it
(`check:pooldb-txn`, `check:tenant-on-pool`).

Read [multi-tenancy.md](multi-tenancy.md) before changing anything in this path.

### Routes that moved out of core

Several `/api/*` paths now return **410 Gone** with a pointer to the extension
that replaced them — `registerCoreRoutes` mounts `goneRoutes(...)` for
`/api/approvals`, `/api/export`, `/api/import`, `/api/media`, `/api/briefing`,
and `/api/edge-functions`. A 410 with a forwarding address is deliberate: it
tells an old client what happened instead of a bare 404.

---

## 4. Data model

Two kinds of table, distinguished by prefix:

| Prefix | Owner | Example |
|---|---|---|
| `zv_*` | Engine core | `zv_api_keys`, `zv_settings`, `zv_tenants` |
| `zvd_*` | Dynamic — user collections and extension tables | `zvd_invoices`, `zvd_crm_contacts` |
| `zv_<ext>_*` | An extension's private namespace | reserved for worker-isolated extensions |

**Collections are dynamic.** Creating a collection issues real DDL through the
DDL manager (`lib/data/ddl-manager.ts`) — a collection is a genuine Postgres
table with real columns, indexes and constraints, not rows in an EAV table.
Large alterations go through [Ghost DDL](../engine/ghost-ddl.md) to avoid
locking tables under load.

Schema migrations for the engine itself are numbered SQL files in
`packages/engine/src/db/migrations/sql/`, embedded into the binary by
`bun run gen:migrations` (a package script in `packages/engine`, not a root one).
The set was squashed for 3.0 and currently runs `001`–`009`; do not assume
higher numbers from older documents.

---

## 5. Trust boundaries

Ordered from most to least trusted:

1. **The operator** — has shell access to the machine and the database. An
   "attack" that requires being the operator is generally not a finding.
2. **The engine process** — holds the database credentials and the encryption
   keys.
3. **First-party extensions** — run in-process (`inline` isolation) by default.
   They are trusted code, reviewed in the `zveltio-extensions` repository.
4. **Community extensions** — run **worker-isolated**: a separate process, a
   restricted SQL allowlist, a reserved connection with a statement timeout, and
   the `zveltio_worker` database role which holds no grants on Better-Auth
   tables. Worker isolation is a guard-rail, not an adversarially-tested sandbox.
5. **Edge functions** — a separate process per invocation with a minimal
   environment. `EDGE_SANDBOX_MODE=worker` is faster and weaker.
6. **Authenticated users** — separated from each other by RBAC, row rules and
   column permissions; separated across tenants by Postgres RLS.
7. **Anonymous requests** — reach nothing under `/api/*`. There is no public
   data API.

See [security.md](security.md) for the threat model this ordering serves.

---

## 6. Technology choices

| Layer | Choice | Note |
|---|---|---|
| Runtime | **Bun 1.3+** (pinned `bun@1.3.14`) | Not Node. Use `Bun.file`, `Bun.spawn`, `Bun.write`. |
| Web framework | Hono 4.13+ | Exact pin, **shared with `zveltio-extensions`** — hono is bundled into every extension artifact, so a version bump does not reach them without a repack. |
| Database | PostgreSQL 18 + pgvector | Both CI and compose pin `pgvector/pgvector:pg18`. |
| Query builder | Kysely | No raw SQL string concatenation; use the `sql` template tag. Gates enforce this. |
| Pooling | PgDog | In deployments; the engine sizes its own pool from `max_connections`. |
| Jobs | pg-boss | |
| Auth | Better-Auth 1.7+ | Sessions, OAuth, passkeys, 2FA. |
| Authorization | Casbin, with domains | Domain = tenant. |
| Isolation | Postgres FORCE RLS | Keyed on a per-transaction GUC. |
| Cache / realtime | Valkey 8 | **Required in production**, not optional. |
| Frontend | SvelteKit 2 + Svelte 5 runes, Tailwind 4, daisyUI 5 | |
| i18n | Paraglide JS (inlang) | 9 locales. |
| Tooling | Biome 2, Turborepo, Playwright, Stryker, Changesets, OpenTelemetry | |

**On Valkey being required.** Without it the permission and identity caches
degrade *in silence*: `isGodUser` and `resolveUserRole` hit the database on every
request, and a revoked grant reaches only the replica that revoked it. A
production boot without `VALKEY_URL` is refused by `productionGuardViolations`.
An operator who genuinely has no cache must say so explicitly with
`ZVELTIO_ALLOW_NO_CACHE=1`.

---

## 7. Where to look in the source

```
packages/engine/src/
├── index.ts            Hono assembly, middleware order, bootstrap()
├── routes/             HTTP layer, one file per domain; admin/ for admin endpoints
│   └── index.ts        registerCoreRoutes() — every core route is mounted here
├── lib/
│   ├── data/           collections, DDL, ghost DDL, query parsing, write pipeline
│   ├── tenancy/        RLS, tenant manager, permissions, row rules, column perms
│   ├── extensions/     loader, registry, sandbox, capabilities, migration runner
│   ├── flows/          automation engine, scheduler, cron
│   ├── runtime/        cache, event bus, realtime bus, telemetry, GC, memory monitor
│   ├── storage/        driver abstraction: local and S3
│   ├── security/       signature verify, keyring, URL validation, SSO sessions
│   ├── edge-functions/ sandbox, subprocess and worker runners, safe fetch
│   └── backup/         scheduler and scheduled-run executor
├── middleware/         tenant resolution, membership, rate limits, tracing, logs
├── db/                 Kysely setup, migrations, auto-migrate, generated schema
├── field-types/        core field type registry
└── tests/              unit/, integration/, harness/, stress/, fixtures/
```

`packages/engine/extensions/` is a **gitignored runtime install cache**, not
extension source. Extension source lives in the sibling repository
`zveltio-extensions`.
