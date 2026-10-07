<!--
  README — canonical source of truth for Zveltio positioning.
  The frontpage at https://zveltio.com (zveltio-website/src/routes/+page.svelte)
  mirrors this narrative with a rich Svelte layout. Both files share the same
  positioning, hero copy, comparison data, and call-to-action text — when
  you edit positioning here, mirror the same changes in the Svelte page.
  (No auto-sync — the rich layout would make a sync script brittle.)
-->

# Zveltio

> **The self-hosted Business OS: a headless backend that becomes your business stack through its extensions.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-blue)](https://github.com/zveltio-devs/zveltio/releases)
[![Bun](https://img.shields.io/badge/Bun-1.3+-red)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Postgres-18-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Built with Claude](https://img.shields.io/badge/Built%20with-Claude-D97757)](https://claude.com/claude-code)

The engine is headless and stays that way: collections with a dynamic schema, auth, row-level multi-tenancy, permissions, a REST/RPC API over your data, automation, realtime, storage, and an admin Studio to run it all. No opinion about how anything is presented — that is what extensions are for.

Install the official extensions and it becomes a business stack: CRM, invoicing, accounting, payroll, inventory, POS, e-commerce, e-Factura. Install none and it is a backend your own app talks to. **Both are supported deployments, not one of them a workaround for the other.**

**Use it headless. Use the extensions to replace your SaaS stack. Or do both.**

Modern TypeScript stack (Bun + Hono + Postgres). AI through an extension. Audit trail and GDPR export/erasure built in. MIT-licensed.

> 🟢 **Beta** (current version in [`packages/engine/package.json`](packages/engine/package.json)) — extensions API + marketplace are API-stable. Engine internals + Studio still iterating. See [Beta caveats](#beta-caveats) for what's locked vs. still moving.

```bash
curl -fsSL https://get.zveltio.com/install.sh | bash
```

**[Deploy →](https://get.zveltio.com)** · **[Browse plugins →](https://zveltio.com/extensions)** · **[Build on Zveltio →](https://zveltio.com/intro)**

---

## Build any business app — self-hosted, modern, yours

The engine ships with everything every business application needs. Activate plugins for common domains, or build custom logic on top.

### What's in the engine core

| Capability | Details |
|---|---|
| **Dynamic Collections** | Schemaless tables created at runtime. No code-side migrations for routine schema changes. |
| **Auth + RBAC + RLS** | Better-Auth (sessions, OAuth, 2FA, passkeys) + Casbin role policies + Postgres row-level security. Tenant isolation is enforced in the database (FORCE RLS keyed on a per-transaction GUC); the per-user row rules configured under `/api/admin/rls` apply to reads, updates and deletes alike. |
| **Real-time** | WebSocket + Postgres LISTEN/NOTIFY. Live updates without polling. |
| **File storage** | Local filesystem by default, zero dependencies. Any S3-compatible backend optional (AWS, MinIO, R2, or the bundled SeaweedFS). |
| **Audit trail** | Every write logged (who, what, when, where). GDPR-ready right-to-erasure. |
| **Edge functions** | The engine runs them; authoring them is the `developer/edge-functions` extension. TypeScript for custom serverless logic, written by instance admins. Runs in a **separate process per invocation** by default, with a minimal environment (`NODE_ENV` only) so engine credentials are never visible to it, plus SSRF-filtered network access and a hard wall-clock kill. There is no in-process mode: the Worker runner was removed once measurement showed it could not be given a memory ceiling and was slower than a pre-spawned process. |
| **Automation flows** | Visual trigger → step builder with DLQ retry and idempotency. |
| **Webhooks** | HMAC-signed outbound webhooks on data changes. |
| **Multi-tenancy** | Isolated tenants with environment branching. |
| **Plugin system** | Engine extensions + Studio extensions, Ed25519-signed. Community extensions run in a worker thread whose SQL is restricted to user tables and their own — a guard-rail inside the engine process, not a sandbox, and off in production unless the operator opts in. |
| **Offline sync** | CRDT-based local-first storage in the SDK (Electric SQL provider optional). |

AI (OpenAI, Anthropic, Ollama, Azure; semantic search via pgvector, text-to-SQL, schema generation) is the `ai` extension, not the core.

### The Studio (admin UI)

A SvelteKit 5 admin panel ships in the same package. Visual collections editor, permissions matrix, query playground, audit log viewer, AI assistant, marketplace browser, dashboard with sparklines + trend deltas. Open `/admin` after install.

Don't like Svelte? The engine exposes everything via REST + WebSocket — bring your own React, Vue, or HTMX admin. The engine is framework-agnostic.

---

## Your business stack, on your hardware. Build it or borrow it.

Three real ways teams use Zveltio today.

### 1. Replace your SaaS stack

Activate the bundled plugins for the SaaS subscriptions you'd rather not pay for anymore.

| What you might be paying for | Zveltio plugin |
|---|---|
| Hosted CRM | `crm` — contacts, organizations, deals pipeline |
| Hosted mail client | `communications/mail` — IMAP/SMTP client with AI compose |
| Hosted automation / integration platform | engine `/api/flows` — visual automation with DLQ + retry (built-in) |
| Cloud point of sale | `operations/pos` — point of sale + inventory + procurement |
| Work-management approvals | `workflow/approvals` — multi-step approval chains, SLA tracking |
| Document template tools | `content/document-templates` — HTML/PDF template engine |
| Serverless functions | `developer/edge-functions` — admin-authored TypeScript functions |
| Headless CMS / site builder | `content/pages` — block-based pages and sites with headless API |
| Hosted AI assistants | `ai` — multi-provider, native to your data |

No per-seat fees: what you pay for is the hardware you run it on.

### 2. Build a vertical product

Build legal-tech, healthcare-CRM, real-estate-management, ag-tech, education-LMS, fintech-back-office. Don't rewrite auth + admin + permissions + audit for the 47th time.

The engine handles plumbing; you focus on domain logic. A vertical SaaS skeleton — collections + auth + RLS + admin UI + REST API — is configuration, not code: you write only the domain logic.

### 3. Custom internal tools

Intranet portals. Employee dashboards. Client area portals — authenticated sites in the `content/pages` extension. Document workflows. Internal analytics. Approval chains tied to your specific org structure.

Self-hosted, owned, modifiable. No SaaS vendor reading your operations data.

---

## How extensions work

Zveltio extensions are **plugins**, not forks. Two types ship together:

### Engine extensions
- TypeScript modules that mount Hono routes at `/ext/<name>/`, declare migrations, hook pre/post-write triggers, alter queries, gate entity access, run cron jobs.
- Signed with Ed25519 at publish time and **verified at install**: a missing or invalid signature fails the install. Set `REQUIRE_EXTENSION_SIGNATURES=false` only for a private mirror that does not sign; to trust an additional signer, add its key to `REGISTRY_PUBLIC_KEYS_JSON` instead.
- Community-tier extensions are **review-gated, signed, and worker-isolated**: their code is never imported into the engine process — the worker loads it — and from there the host restricts their SQL to user-data tables and their own `zv_<ext>_*` namespace, on a reserved connection with a statement timeout, running as a database role (`zveltio_worker`) that holds no grant at all on the tables Better-Auth owns. Until 3.0.0-beta.61 that restriction was a denylist of table-name prefixes with no rule for unprefixed names, so an extension could read `session` and `account` directly; it is an allowlist now, with the role beneath it as the layer that survives the next mistake in the string matching. Worker isolation is a guard-rail, not a sandbox: the worker is a thread inside the engine process, so its JavaScript environment holds no engine credentials but it shares the process with them. Production therefore loads worker-isolated extensions only when the operator sets `ZVELTIO_ALLOW_WORKER_EXTENSIONS=1`, and an instance that installs untrusted community code is still trusting the review. Where such code runs, give the engine its credentials through `<NAME>_FILE` rather than environment variables. An out-of-process runner for third-party code is planned (RFC zveltio#907).
- The capability policy (`db.read` / `db.write` / `fetch.https` / …) is currently enforced for the WASM host only; JS extensions are governed by the worker/table restrictions above rather than per-capability grants.
- Optional WASM runtime for strict isolation (Rust / TinyGo / AssemblyScript).

### Studio extensions
- Svelte 5 components packaged at publish time, copied into the Studio route tree on enable.
- Register slots, form-alter hooks, custom field types via typed SDK imports (`@zveltio/sdk/studio`).

### Installation model
- Engine downloads signed archives from the marketplace (registry verified by hardcoded pubkey).
- Studio rebuilds itself with the new pages — bulletproof against Svelte runtime fragmentation (we tried dynamic component loading; it broke. Postmortem in `git log alpha.71..alpha.74`).
- Both engine routes and Studio pages appear without engine restart for the API layer.

Build your own: `zveltio extension create <name>` scaffolds. `zveltio extension publish` signs + uploads. Full guide: [docs/extensions/developer-guide.md](docs/extensions/developer-guide.md).

---

## What you can install today

55 first-party extensions, organized by domain. Browse the full catalog at `/admin/marketplace` after install, or read [docs/extensions/catalog.md](docs/extensions/catalog.md).

Some capabilities are the engine itself rather than an extension — collections,
storage, webhooks, realtime, audit, notifications, automation flows, backup,
insights, saved queries, schema branches, tenants — so they are not in that 56.
See [What is not an extension](docs/extensions/overview.md#what-is-not-an-extension).

**Data & Content** · `content/pages` (block-based pages and sites, including authenticated portals) · `content/documents` · `content/document-templates` · `content/media` · `content/drafts` · `content/pdf-viewer` · `forms` · `search` · `data/import` · `data/export`

**Customer & Business** · `crm` · `ecommerce/store` · `operations/pos` · `operations/inventory` · `operations/assets` · `operations/traceability` · `finance/invoicing` · `finance/quotes` · `finance/expenses` · `finance/accounting` · `finance/banking` · `finance/subscriptions` · `billing`

**Workflow & Automation** · `workflow/approvals` · `workflow/checklists` · `projects/management` · `projects/helpdesk` _(automation `flows` live in engine core, not as a plugin)_

**Communications & HR** · `communications/mail` · `sms` · `hr/employees` · `hr/time-tracking` · `hr/leave` · `hr/payroll`

**Developer & Integrations** · `developer/edge-functions` · `developer/graphql` · `developer/api-docs` · `developer/byod` (import tables from an existing database) · `developer/validation` · `integrations/api-connector` · `integrations/migrators` (HubSpot, Notion, Airtable)

**Intelligence** · `ai` (multi-provider) · `analytics/dashboard` (per-role home dashboards) · `analytics/quality`

**Auth & Compliance** · `auth/saml` · `auth/ldap` · `auth/scim` · `compliance/gdpr` · `compliance/ro/efactura` · `compliance/ro/saft` · `compliance/ro/etransport` · `compliance/ro/procurement` · `compliance/ro/documents`

**Infrastructure** · `storage/cloud` · `geospatial/postgis` · `i18n/translations`

Country-specific compliance currently ships **Romanian** packs (e-Factura, SAF-T, e-Transport ANAF). The architecture supports building equivalents for any market — US Sales Tax, UK MTD, German Elster, Italian SDI, French CFI. PRs welcome.

---

## Strengths and trade-offs

**Where Zveltio is strong**

- **Yours to run.** MIT-licensed and self-hosted: it runs on your hardware and the data never leaves it. No per-seat fees, no cloud account required.
- **Isolation in the database.** Tenant isolation is FORCE row-level security in PostgreSQL, keyed on a per-transaction setting — not an application filter. Hierarchical tenants: a parent can read its subtree and write only its own node.
- **Backend and business stack on the same data.** The headless engine and the business extensions (CRM, invoicing, accounting, payroll, POS, e-commerce) share one database, one permission model and one audit trail.
- **Schema changes on live tables.** Ghost DDL copies and swaps, so writes block only for milliseconds at the swap; schema branches get a diff, review, preview and merge first.
- **Extensions are signed and fenced.** Ed25519 signatures verified at install; community code runs in a worker whose SQL is limited to user tables and its own, under a database role with no access to auth tables — a guard-rail in the engine process, opt-in in production, not a sandbox. Admin pages are declarative JSON, so no third-party JavaScript reaches the admin.
- **Compliance built in.** Audit trail on every write, GDPR export and erasure, per-field encryption, and Romanian fiscal packs (e-Factura, SAF-T, e-Transport).

**Where it is not there yet**

- **Beta.** The extension API and marketplace flow are stable; engine internals and the Studio still move. No SOC 2 or ISO 27001 certification.
- **Small ecosystem.** 55 first-party extensions; third-party submissions are reviewed by hand and the community is small.

---

## Who's it for

✅ **Software agencies** building custom apps for clients — skip the auth, admin, permissions and audit plumbing, and hand clients software they own.

✅ **SMEs and mid-market** consolidating their SaaS stack onto one self-hosted platform.

✅ **Vertical SaaS founders** — legal-tech, real-estate, healthcare, ag-tech, education-LMS. Don't rewrite auth.

✅ **Enterprises and public sector** with data-sovereignty requirements — data stays on your hardware.

✅ **Startups** that need a full business stack without a subscription per tool.

❌ **Not for**: a blog or brochure site, or a single-purpose CRUD app — both need far less than this.

---

## Tech stack

No hidden dependencies. No surprises.

| Layer | Technology | Why |
|---|---|---|
| Runtime | [Bun](https://bun.sh) 1.3+ | TypeScript-native, fast startup, batteries included |
| Web framework | [Hono](https://hono.dev) 4.4+ | Edge-friendly, typed RPC, ultra-low overhead |
| Database | [PostgreSQL](https://www.postgresql.org/) 18 with pgvector | Full RDBMS + AI vector search, no NoSQL chaos |
| Query builder | [Kysely](https://kysely.dev) 0.27+ | Type-safe SQL, no ORM tax |
| Connection pool | [PgDog](https://github.com/pgdogdev/pgdog) | Multi-threaded, scram-sha-256 native |
| Cache & realtime | [Valkey](https://valkey.io) 8+ | **Required.** Redis-compatible, fully open. Permission invalidation travels through it, so an engine without one serves revoked grants on every replica but the one that revoked them — the engine refuses to start in production without `VALKEY_URL`. Every install path provisions it. |
| Auth | [Better-Auth](https://better-auth.com) 1.6+ | Sessions, OAuth, passkeys, 2FA, magic links |
| Authorization | [Casbin](https://casbin.org) 5.30+ | RBAC + ABAC policy engine |
| File storage | Local filesystem (default) · optional S3-compatible backend, e.g. [SeaweedFS](https://github.com/seaweedfs/seaweedfs) 3.68 | `STORAGE_DRIVER=local` needs nothing installed; `s3` talks to any S3 API |
| Admin UI | [SvelteKit](https://kit.svelte.dev) 2 + Svelte 5 runes | Modern reactive, small bundles |
| Job queue | [pg-boss](https://github.com/timgit/pg-boss) 12 | Postgres-native, no separate Redis queue |
| Migration safety | [squawk](https://squawkhq.com) lint | CI-time DDL safety analysis |
| Observability | [OpenTelemetry](https://opentelemetry.io) | Industry-standard tracing |
| i18n | [Paraglide JS](https://inlang.com) 2.18+ | Type-safe translations, tree-shakeable |
| Charts | [Layerchart](https://layerchart.com) | Svelte 5 first, D3-powered |

---

## Getting started

### Quick install (recommended)

```bash
curl -fsSL https://get.zveltio.com/install.sh | bash
```

Interactive installer — picks Docker or native, configures `.env`, runs migrations, creates god user.

### Docker

```bash
# Release assets live on GitHub; get.zveltio.com only says which version is current.
V=$(curl -fsSL https://get.zveltio.com/latest.json | grep -o '"version": *"[^"]*"' | cut -d'"' -f4)
BASE=https://github.com/zveltio-devs/zveltio/releases/download/v$V
curl -fsSL $BASE/docker-compose.yml -o docker-compose.yml
curl -fsSL $BASE/env.example -o .env
# Edit .env (POSTGRES_PASSWORD, VALKEY_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL, S3_SECRET_KEY)
docker compose up -d
```

Engine: `http://localhost:3000`. Studio: `http://localhost:3000/admin`.

### Native binary

```bash
# Release assets live on GitHub; get.zveltio.com only says which version is current.
V=$(curl -fsSL https://get.zveltio.com/latest.json | grep -o '"version": *"[^"]*"' | cut -d'"' -f4)
BASE=https://github.com/zveltio-devs/zveltio/releases/download/v$V
curl -fsSL $BASE/zveltio-linux-x64 -o zveltio
chmod +x zveltio && ./zveltio start
```

Five binaries available: `linux-x64`, `linux-x64-baseline` (older CPUs), `linux-arm64`, `macos-x64`, `macos-arm64`.

### Develop & contribute

```bash
git clone https://github.com/zveltio-devs/zveltio.git
cd zveltio
bun install
docker compose -f docker-compose.infra.yml up -d   # Postgres, Valkey (+ SeaweedFS, opt-in)
cp .env.example .env
bun run dev                                         # engine with hot reload
cd packages/studio && bun run dev                   # admin UI on :5173
```

Building extensions: [docs/extensions/developer-guide.md](docs/extensions/developer-guide.md).

### Supported platforms

| Purpose | Supported |
|---|---|
| **Deploy / run** | Linux (x64, x64-baseline, arm64), macOS (x64, arm64). No Windows binary is shipped. |
| **Develop & test** | Linux, macOS, WSL2. |
| **Native Windows** | Editing and most tooling work. Run the test suite under **WSL2**, not native Windows — Bun's package store uses symlinks that `bun test` cannot read natively (`EACCES`), so the suite reports spurious failures there. This is a Bun/Windows toolchain limitation, not a Zveltio bug. |

---

## Architecture

```
                  ┌────────────────────────────────────┐
                  │  REST / WebSocket / GraphQL API    │
                  └────────────────────────────────────┘
                                  ▲
                                  │ /api/*  /ext/<plugin>/*
                                  │
          ┌───────────────────────┴───────────────────────┐
          │   Engine binary (Bun + Hono)                  │
          │   • Auth + RBAC + RLS                         │
          │   • Collections + dynamic schema              │
          │   • Real-time bus + audit trail               │
          │   • AI providers + edge functions             │
          │   • Plugin runtime (signed, SQL-fenced)       │
          └───────────────┬───────────────────┬───────────┘
                          │                   │
                  ┌───────▼────────┐   ┌──────▼──────┐
                  │  Postgres 18   │   │  Valkey 8   │
                  │  + pgvector    │   │ cache+pubsub│
                  └────────────────┘   └─────────────┘

  Clients (any): ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────────┐
                 │ Studio  │ │ Intranet │ │ Client  │ │ 3rd-party  │
                 │ (Svelte)│ │ (Svelte) │ │(Svelte) │ │  React/Vue │
                 └─────────┘ └──────────┘ └─────────┘ └────────────┘
```

**Engine** is framework-agnostic. We ship a Svelte 5 Studio for administration; portals for your users are sites in the `content/pages` extension, and you can replace either with a custom React, Vue or HTMX frontend over the REST and WebSocket API.

---

## Running more than one tenant

If you serve several tenants from one instance, read
**[docs/platform/multi-tenancy.md](docs/platform/multi-tenancy.md)** before you
do. One item there is not optional:

> The engine's database role must not be `SUPERUSER` or carry `BYPASSRLS`.

Postgres exempts superusers from row-level security, and the official Postgres
image makes `POSTGRES_USER` a superuser — so a default install starts in that
state. The engine mitigates it: every tenant-scoped transaction switches to a
plain `zveltio_rls` role, which the isolation policies do bind to, and the
engine warns at boot when it notices. Code that runs outside a request — a
migration, a background job — has no such transaction to inherit, which is why
the role still matters.

Do not fix it with a blanket `ALTER ROLE … NOSUPERUSER`; that breaks
`CREATE EXTENSION`. The document explains what to do instead.

## Beta caveats

Honest about where we are: still beta. The current version is in [`packages/engine/package.json`](packages/engine/package.json).

> **Why 3.x while still beta?** Early in the project a few npm packages were
> mis-published at `2.0.x` (those version numbers can never be reused). The
> line was realigned to `3.0.0` so `npm i @zveltio/*` resolves to real code
> with no collision. "beta" is the platform maturity, independent of the
> now-3.x number. See the CHANGELOG `[3.0.0-beta.1]` entry.

**What's API-stable in beta (will NOT break between beta.x and v1.0):**
- Extension manifest v2 (`engine.bundled`, `engine.isolation`,
  `integrity.engineSha256`, `bundlePeers`)
- `ZveltioExtension` SDK interface + `@zveltio/sdk/extension` types
- `@zveltio/sdk/build` plugin config (custom build pipelines)
- Marketplace publish flow + review queue endpoints
- Worker isolation contract (credential-free worker environment, table-restricted SQL bridge, ping/pong heartbeat, crash respawn) — a guard-rail inside the engine process, not a sandbox

**What may still move in beta.x:**
- Engine internal helpers not exported via SDK
- Studio admin UI layout + components
- Beta releases may introduce schema migrations (run via `zveltio start` auto-migrate)

✅ **Stable enough for**: production self-hosted deploys, agency-built apps, internal tools, vertical SaaS, custom platforms with engineering ownership.

⚠️ **Not yet for**: business-critical paths in regulated industries (no SOC2 / ISO 27001 yet — those are post-1.0), enterprise contracts requiring formal SLAs, headless multi-region at scale without operational maturity.

**Marketplace controlled launch**: community extension submissions are technically accepted, but every submission lands `pending` and stays there until an admin approves manually via `apps.zveltio.com/admin/marketplace/*` or the `zveltio admin marketplace` CLI. The review team and SLA are documented as operator decisions in [`docs/extensions/marketplace-policy.md`](docs/extensions/marketplace-policy.md) §9.

**Production stability**: the underlying stack (Postgres + Bun + Hono + Better-Auth + Casbin) is production-mature. Unit and integration suites run in CI on every commit.

**Alpha track EOL**: `1.0.0-alpha.*` is **closed** as of beta.1 (2026-05-31). Last alpha: **alpha.129**. We do not publish new alpha tags; releases stay on GitHub for audit only. **Install beta** (`get.zveltio.com`) or run `zveltio update` for the latest beta.

**Migration from alpha**: the `1.0.0-alpha.*` track is closed. If you ran any alpha.111+ release you'll auto-migrate cleanly; for older alpha-track installs the migration is one-way.

**v1.0 target**: the extension platform is ✅ done at beta.1; the remaining v1.0 work is product rather than engineering — benchmarks, demo.zveltio.com, case studies.

---

## License

MIT — see [LICENSE](LICENSE). No per-seat fees, no commercial restriction, no source-available bait-and-switch.

If you build something on Zveltio that helps your business, the only thing we ask is a star ⭐ on this repo and — if you can spare it — a write-up so others know it's viable.

---

## The platform behind your business. Build it. Plug it in. Own it forever.

Zveltio is a product of [DaRe IT Systems S.R.L.](https://dareit.ro) — based in Romania, open to the world.

Built with [Claude](https://claude.com/claude-code).

**[Read the docs →](https://zveltio.com/intro)** · **[Join the community →](https://github.com/zveltio-devs/zveltio/discussions)** · **[Report an issue →](https://github.com/zveltio-devs/zveltio/issues)**
