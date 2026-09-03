# Chapter 2 — Engine

The Bun + Hono server. Everything else in the product is a client of it.

`packages/engine` · `@zveltio/engine` · version tracks the repository
(`3.0.0-beta.64`).

| Document | Covers |
|---|---|
| [api-reference.md](api-reference.md) | REST endpoints, request and response shapes |
| [collections.md](collections.md) | Dynamic collections, field types, relations |
| [ghost-ddl.md](ghost-ddl.md) | Zero-downtime schema changes on large tables |
| [authentication.md](authentication.md) | Better-Auth: sessions, OAuth, passkeys, 2FA |
| [authorization.md](authorization.md) | Casbin RBAC, row rules, column permissions, the god role |
| [webhooks.md](webhooks.md) | Outbound HMAC-signed webhooks |
| [graphql.md](graphql.md) | The GraphQL surface (provided by the `developer/graphql` extension) |
| [offline-sync.md](offline-sync.md) | Local-first sync, Electric SQL, CRDTs |
| [self-hosted-ai.md](self-hosted-ai.md) | AI providers, including fully local models |
| [kms.md](kms.md) | External key management |
| [sdk.md](sdk.md) | `@zveltio/sdk` and the framework bindings |
| [cli.md](cli.md) | The `zveltio` binary |

Cross-cutting material lives in the Platform chapter:
[architecture](../platform/architecture.md) (boot sequence, request lifecycle),
[multi-tenancy](../platform/multi-tenancy.md), [security](../platform/security.md),
[configuration](../platform/configuration.md).

---

## Source layout

```
packages/engine/src/
├── index.ts        Hono assembly, middleware order, bootstrap()
├── routes/         HTTP layer — one file per domain
│   ├── index.ts    registerCoreRoutes(): every core route is mounted here
│   └── admin/      admin-only endpoints
├── lib/            domain modules (below)
├── middleware/     tenant resolution, membership, rate limits, tracing, logging
├── db/             Kysely setup, migrations, auto-migrate, generated schema
├── field-types/    core field type registry
├── workers/        worker entry points
├── templates/      seed templates
└── tests/          unit/ integration/ harness/ stress/ fixtures/
```

### `lib/` — the domain modules

| Module | Responsibility |
|---|---|
| `data/` | Collections and everything that writes to them: `ddl-manager`, `ddl-queue`, `ghost-ddl`, `query-parse`, `query-alter`, `write-pipeline`, `field-crypto`, `field-type-registry`, per-verb `handlers/` |
| `tenancy/` | The isolation boundary: `tenant-manager`, `tenant-context`, `tenant-scope`, `rls`, `permissions`, `entity-access`, `column-permissions`, `row-rule-policy`, `rule-operators`, `resource-grants` |
| `extensions/` | Loading and running plugins: `discovery`, `load`, `register`, `lifecycle`, `extension-sandbox`, `capabilities`, `manifest-schema`, `migration-runner`, `worker-sql-policy`, `consent`, `revocations` |
| `flows/` | Automation: `flow-executor`, `flow-scheduler`, `flow-step-schemas`, `cron` |
| `runtime/` | Process-level services: `cache`, `event-bus`, `realtime-bus`, `cron-runner`, `telemetry`, `garbage-collector`, `memory-monitor` |
| `storage/` | `driver` abstraction with `local-driver` and `s3-driver`, plus `probe` |
| `security/` | `signature-verify`, `registry-keys`, `keyring`, `url-validator`, `ws-origin`, `sso-session`, `api-key-hash` |
| `edge-functions/` | `sandbox`, `subprocess-runner`, `worker-runner`, `safe-fetch`, `sandbox-lockdown` |
| `backup/` | `scheduler`, `run-scheduled-backup` |
| `cloud/` | `document-indexer` (text extraction), `trash` |

Top-level files in `lib/` carry the rest: `audit.ts`, `auth.ts`, `webhooks.ts`,
`webhook-worker.ts`, `notifications.ts`, `push-notifications.ts`,
`validation-engine.ts`, `startup-guards.ts`, `health-registry.ts`,
`service-registry.ts`, `problem.ts`, `worker-extension-host.ts`,
`wasm-extension-host.ts`.

---

## Adding a route

1. Create the handler file in `routes/`.
2. Mount it in `registerCoreRoutes` in `routes/index.ts`. Routes registered
   anywhere else do not exist as far as this codebase is concerned.
3. Put an auth guard on it. Copy the pattern from an existing admin route.
4. If it is privileged, call `auditLog()` — `scripts/audit-regression-check.ts`
   fails the build otherwise.
5. Reach tenant data only through the request-scoped database handle.

**Hono matches paths exactly and resolves in registration order.** A static
route registered after a same-method `:param` route is shadowed by it;
`scripts/route-collision-check.ts` gates this. `/api/thing/` 308-redirects to
`/api/thing` by design.

---

## The data path

A write to a collection goes through the **write pipeline**
(`lib/data/write-pipeline.ts`), in this order:

1. Field validation (`validation-engine.ts`) — including rule groups with
   AND/OR semantics.
2. Column permissions — `filterWritableFields` drops fields the caller's role
   may not write, and reports them as `blocked` rather than silently ignoring
   them.
3. Reserved-field protection — `created_by`, `updated_by`, `tenant_id` and
   friends are set by the system, never taken from the request body.
4. Pre-write extension hooks.
5. Field encryption for fields marked `encrypted: true`.
6. The statement itself, inside the request's tenant transaction.
7. Post-write hooks, audit log, event bus, realtime broadcast, webhooks.

Reads go through `query-parse.ts` (filters, sorting, pagination) and
`query-alter.ts` (extension query rewriting), then row-level checks:
`entityAccessRegistry` on both single reads and lists, and column filtering to
remove `hidden` columns from the response.

**Table prefixes:** `zv_*` is engine core, `zvd_*` is dynamic (collections and
extension tables), `zv_<ext>_*` is an extension's private namespace.

---

## Background services

Started at the end of `bootstrap()` and worth knowing about when debugging
"something happened and no request caused it":

| Service | What it does |
|---|---|
| Event bus | In-process domain events; `LISTEN/NOTIFY` across replicas |
| Realtime bus | WebSocket and SSE fan-out, presence |
| Cron runner | Extension-declared cron jobs |
| Flow scheduler | Time-triggered automation flows |
| Webhook worker | Asynchronous delivery with retry and a dead-letter queue |
| Backup scheduler | Scheduled database backups |
| Garbage collector | Expired sessions, trash, orphaned uploads |
| Memory monitor | Heap pressure reporting |

---

## Clients

- **`@zveltio/sdk`** — the public SDK. Subpath exports: `.`, `./extension`,
  `./codegen`, `./validate`, `./testing`, `./publish`, `./build`, `./studio`,
  `./ddl`, `./rpc`, `./offline`. **API-stable — do not break it.**
- **`@zveltio/react`, `@zveltio/vue`** — thin bindings over the SDK.
- **`@zveltio/cli`** — the `zveltio` binary: `init`, `dev`, `start`, `deploy`,
  `status`, `create-god`, `migrate`, `rollback`, `update`, `install`,
  `generate types`, plus the `extension`, `extensions`, `keys` and `admin`
  command groups. See [cli.md](cli.md).
