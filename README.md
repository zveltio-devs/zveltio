<!--
  README — canonical source of truth for Zveltio positioning.
  The frontpage at https://zveltio.com (zveltio-website/src/routes/+page.svelte)
  mirrors this narrative with a rich Svelte layout. Both files share the same
  positioning, hero copy, comparison data, and call-to-action text — when
  you edit positioning here, mirror the same changes in the Svelte page.
  (No auto-sync — the rich layout would make a sync script brittle.)
-->

# Zveltio

> **The open-source platform for any business application.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-blue)](https://github.com/zveltio-devs/zveltio/releases)
[![Bun](https://img.shields.io/badge/Bun-1.3+-red)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Postgres-17+-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)

Zveltio is a self-hosted foundation for building business applications. It bundles the core every business app needs — collections, auth, permissions, real-time, AI, audit trail, automation, file storage, edge functions — into a single binary with an extensible plugin system.

**Use the included plugins to replace your SaaS stack. Build custom applications on the core. Or do both.**

Modern TypeScript stack (Bun + Hono + Postgres). AI-native. GDPR-compliant by default. MIT-licensed.

> 🟢 **Beta (3.0.0-beta.31)** — extensions API + marketplace are API-stable. Engine internals + Studio still iterating. See [Beta caveats](#beta-caveats) for what's locked vs. still moving.

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
| **Auth + RBAC + RLS** | Better-Auth (sessions, OAuth, 2FA, passkeys) + Casbin role policies + Postgres row-level security. |
| **Real-time** | WebSocket + Postgres LISTEN/NOTIFY. Live updates without polling. |
| **File storage** | S3-compatible (SeaweedFS bundled, or BYO AWS/MinIO/R2). |
| **AI providers** | OpenAI, Anthropic, Ollama, Azure. Semantic search via pgvector, text-to-SQL, schema generation from natural language. |
| **Audit trail** | Every write logged (who, what, when, where). GDPR-ready right-to-erasure. |
| **Edge functions** | Sandboxed TypeScript runtime for custom serverless logic. |
| **Automation flows** | Visual trigger → step builder with DLQ retry and idempotency. |
| **Webhooks** | HMAC-signed outbound webhooks on data changes. |
| **Multi-tenancy** | Isolated tenants with environment branching. |
| **Plugin system** | Engine extensions + Studio extensions, signed, capability-policy sandboxed. |
| **Offline sync** | CRDT-based local-first storage (Electric SQL provider optional). |

### The Studio (admin UI)

A SvelteKit 5 admin panel ships in the same package. Visual collections editor, permissions matrix, query playground, audit log viewer, AI assistant, marketplace browser, dashboard with sparklines + trend deltas. Open `/admin` after install.

Don't like Svelte? The engine exposes everything via REST + WebSocket — bring your own React, Vue, or HTMX admin. The engine is framework-agnostic.

---

## Your business stack, on your hardware. Build it or borrow it.

Three real ways teams use Zveltio today.

### 1. Replace your SaaS stack

Activate the bundled plugins for the SaaS subscriptions you'd rather not pay for anymore.

| SaaS you might replace | Zveltio plugin |
|---|---|
| HubSpot / Pipedrive | `crm` — contacts, organizations, deals pipeline |
| Hosted IMAP+SMTP / Front | `communications/mail` — full mail client with AI compose |
| Zapier / Make / n8n | engine `/api/flows` — visual automation with DLQ + retry (built-in) |
| Square / Shopify POS | `operations/pos` — point of sale + inventory + procurement |
| Monday / Asana approvals | `workflow/approvals` — multi-step approval chains, SLA tracking |
| Notion / Coda templates | `content/document-templates` — HTML/PDF template engine |
| Cloudflare Workers / Lambda | `developer/edge-functions` — sandboxed TypeScript serverless |
| Contentful / Sanity | `content/page-builder` — block-based CMS with headless API |
| ChatGPT Teams / Copilot | `ai` — multi-provider, native to your data |
| AppSheet / Glide | `developer/views` — kanban, calendar, gallery, map layouts |

A typical SME running 10-15 of these subscriptions saves **€2 000-5 000 / month** — without per-seat fees.

### 2. Build a vertical product

Build legal-tech, healthcare-CRM, real-estate-management, ag-tech, education-LMS, fintech-back-office. Don't rewrite auth + admin + permissions + audit for the 47th time.

The engine handles plumbing; you focus on domain logic. A typical vertical SaaS skeleton — collections + auth + RLS + admin UI + REST API — is **0 lines of code** in Zveltio.

### 3. Custom internal tools

Intranet portals. Employee dashboards. Client area portals. Document workflows. Internal analytics. Approval chains tied to your specific process.

Self-hosted, owned, modifiable. No SaaS vendor reading your operations data.

---

## How extensions work

Zveltio extensions are **plugins**, not forks. Two types ship together:

### Engine extensions
- TypeScript modules that mount Hono routes at `/ext/<name>/`, declare migrations, hook pre/post-write triggers, alter queries, gate entity access, run cron jobs.
- Signed with Ed25519 at publish time, verified at install.
- Capability-policy sandboxed — explicit `db.read` / `db.write` / `fetch.https` / `crypto.subtle` / `env.read` grants. Denials logged.
- Optional WASM runtime for strict isolation (Rust / TinyGo / AssemblyScript).

### Studio extensions
- Svelte 5 components packaged at publish time, copied into the Studio route tree on enable.
- Register slots, form-alter hooks, custom field types via typed SDK imports (`@zveltio/sdk/studio`).

### Installation model
- Engine downloads signed archives from the marketplace (registry verified by hardcoded pubkey).
- Studio rebuilds itself with the new pages — bulletproof against Svelte runtime fragmentation (we tried dynamic component loading; it broke. Postmortem in `git log alpha.71..alpha.74`).
- Both engine routes and Studio pages appear without engine restart for the API layer.

Build your own: `zveltio extension init <name>` scaffolds. `zveltio extension publish` signs + uploads. Full guide: [docs/EXTENSION-DEVELOPER-GUIDE.md](docs/EXTENSION-DEVELOPER-GUIDE.md).

---

## What you can install today

54 first-party plugins, organized by domain. Browse the full catalog at `/admin/marketplace` after install.

**Data & Content** · `collections` (core) · `views` (kanban, calendar, gallery, map) · `content/page-builder` (CMS) · `content/documents` · `content/document-templates` · `content/media` · `content/drafts`

**Customer & Business** · `crm` · `operations/pos` · `operations/inventory` · `operations/assets` · `operations/traceability` · `finance/invoicing` · `finance/quotes` · `finance/expenses` · `finance/accounting` · `finance/banking`

**Workflow & Automation** · `webhooks` · `notifications` · `workflow/approvals` · `workflow/checklists` · `projects/management` · `projects/helpdesk` _(automation `flows` live in engine core, not as a plugin)_

**Communications & HR** · `communications/mail` · `hr/employees` · `hr/time-tracking` · `hr/leave`

**Developer** · `developer/edge-functions` · `developer/graphql` · `developer/api-docs` · `developer/byod` · `developer/database` · `developer/validation` · `saved-queries` · `schema-branches` · `sql-editor`

**Intelligence** · `ai` (multi-provider) · `insights` (analytics dashboards) · `analytics/quality`

**Auth & Compliance** · `auth/saml` · `auth/ldap` · `compliance/gdpr` · `compliance/ro/efactura` · `compliance/ro/saft` · `compliance/ro/etransport` · `compliance/ro/procurement` · `compliance/ro/documents`

**Infrastructure** · `storage/cloud` · `backup` (PITR + scheduled) · `geospatial/postgis` · `i18n/translations`

Country-specific compliance currently ships **Romanian** packs (e-Factura, SAF-T, e-Transport ANAF). The architecture supports building equivalents for any market — US Sales Tax, UK MTD, German Elster, Italian SDI, French CFI. PRs welcome.

---

## Zveltio vs alternatives

A platform, not a category. Here's where it lands relative to neighbours:

| | **Zveltio** | Salesforce / Monday / HubSpot | Odoo | Supabase / Pocketbase | Retool / Tooljet |
|---|---|---|---|---|---|
| **Self-hosted** | ✅ | ❌ SaaS only | ✅ | partial (community) | partial (paid) |
| **License** | MIT | proprietary | LGPL / proprietary | Apache / MIT | Elastic / proprietary |
| **Modern stack** | ✅ TS + Bun | N/A | ❌ Python / PHP era | ✅ TS | ✅ TS |
| **AI-native** | ✅ | partial | ❌ | partial | partial |
| **Per-seat fee** | ❌ | $30-300 / seat / mo | partial | tier-based | $10-50 / user / mo |
| **Plugin ecosystem** | ✅ open, growing | ✅ closed marketplace | ✅ ERP-shaped | ❌ | ❌ |
| **Custom code first-class** | ✅ | platform-only | constrained | ✅ | constrained (low-code) |
| **GDPR built-in** | ✅ | bolted on | partial | partial | partial |
| **Total ownership** | ✅ MIT + self-host | ❌ | partial | partial | partial |

We're closest to **Odoo conceptually** (full business platform with plugins) but rebuilt on a modern stack with AI as a first-class concern, not an afterthought. We're closest to **Salesforce Platform / Microsoft Power Platform** in the "build your business apps on this foundation" sense — but FOSS, self-hosted, and a fraction of the cost.

---

## Who's it for

✅ **Software agencies** building custom apps for clients — reduce boilerplate 60-70%, ship in weeks not months.

✅ **SMEs and mid-market** consolidating their SaaS stack — replace 8-15 subscriptions with one self-hosted platform.

✅ **Vertical SaaS founders** — legal-tech, real-estate, healthcare, ag-tech, education-LMS. Don't rewrite auth.

✅ **Enterprises and public sector** with data-sovereignty requirements — data stays on your hardware.

✅ **Startups** that need a full business stack but don't have €3-5K / month for SaaS.

❌ **Not for**: bloggers (use WordPress / Ghost), pure mobile-app backends (use Supabase / Firebase), single-purpose CRUD apps (use a boilerplate), teams with zero ops capability (use managed SaaS).

---

## Tech stack

No hidden dependencies. No surprises.

| Layer | Technology | Why |
|---|---|---|
| Runtime | [Bun](https://bun.sh) 1.3+ | TypeScript-native, fast startup, batteries included |
| Web framework | [Hono](https://hono.dev) 4.4+ | Edge-friendly, typed RPC, ultra-low overhead |
| Database | [PostgreSQL](https://www.postgresql.org/) 17+ with pgvector | Full RDBMS + AI vector search, no NoSQL chaos |
| Query builder | [Kysely](https://kysely.dev) 0.27+ | Type-safe SQL, no ORM tax |
| Connection pool | [PgDog](https://github.com/pgdogdev/pgdog) | Multi-threaded, scram-sha-256 native |
| Cache & realtime | [Valkey](https://valkey.io) 8+ | Redis-compatible, fully open |
| Auth | [Better-Auth](https://better-auth.com) 1.6+ | Sessions, OAuth, passkeys, 2FA, magic links |
| Authorization | [Casbin](https://casbin.org) 5.30+ | RBAC + ABAC policy engine |
| File storage | [SeaweedFS](https://github.com/seaweedfs/seaweedfs) 3.68 | S3-compatible, self-hostable |
| Admin UI | [SvelteKit](https://kit.svelte.dev) 2 + Svelte 5 runes | Modern reactive, small bundles |
| Job queue | [pg-boss](https://github.com/timgit/pg-boss) 12 | Postgres-native, no separate Redis queue |
| Migration safety | [Atlas](https://atlasgo.io) lint | CI-time DDL safety analysis |
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
curl -fsSL https://get.zveltio.com/docker-compose.yml -o docker-compose.yml
curl -fsSL https://get.zveltio.com/.env.example -o .env
# Edit .env (BETTER_AUTH_SECRET, S3 keys, GRAFANA_ADMIN_PASSWORD)
docker compose up -d
```

Engine: `http://localhost:3000`. Studio: `http://localhost:3000/admin`.

### Native binary

```bash
curl -fsSL https://get.zveltio.com/releases/latest/zveltio-linux-x64 -o zveltio
chmod +x zveltio && ./zveltio start
```

Five binaries available: `linux-x64`, `linux-x64-baseline` (older CPUs), `linux-arm64`, `macos-x64`, `macos-arm64`.

### Develop & contribute

```bash
git clone https://github.com/zveltio-devs/zveltio.git
cd zveltio
bun install
docker compose -f docker-compose.infra.yml up -d   # Postgres, Valkey, SeaweedFS
cp .env.example .env
bun run dev                                         # engine with hot reload
cd packages/studio && bun run dev                   # admin UI on :5173
```

Building extensions: [docs/EXTENSION-DEVELOPER-GUIDE.md](docs/EXTENSION-DEVELOPER-GUIDE.md).

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
          │   • Plugin runtime (signed, sandboxed)        │
          └───────────────┬───────────────────┬───────────┘
                          │                   │
                  ┌───────▼────────┐   ┌──────▼──────┐
                  │  Postgres 17   │   │  Valkey 8   │
                  │  + pgvector    │   │ cache+pubsub│
                  └────────────────┘   └─────────────┘

  Clients (any): ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────────┐
                 │ Studio  │ │ Intranet │ │ Client  │ │ 3rd-party  │
                 │ (Svelte)│ │ (Svelte) │ │(Svelte) │ │  React/Vue │
                 └─────────┘ └──────────┘ └─────────┘ └────────────┘
```

**Engine** is framework-agnostic. We ship a Svelte 5 Studio + Intranet + Client zones, but you can replace any of them with a custom React / Vue / HTMX UI that consumes `/api/*`. The plugin marketplace is Svelte-first because the bundled Studio is Svelte; the engine API is open to anyone.

---

## Beta caveats

Honest about where we are: **3.0.0-beta.31** as of the latest release.

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
- Worker isolation contract (no DB credentials in worker, ping/pong heartbeat, crash respawn)

**What may still move in beta.x:**
- Engine internal helpers not exported via SDK
- Studio admin UI layout + components
- Beta releases may introduce schema migrations (run via `zveltio start` auto-migrate)

✅ **Stable enough for**: production self-hosted deploys, agency-built apps, internal tools, vertical SaaS, custom platforms with engineering ownership.

⚠️ **Not yet for**: business-critical paths in regulated industries (no SOC2 / ISO 27001 yet — those are post-1.0), enterprise contracts requiring formal SLAs, headless multi-region at scale without operational maturity.

**Marketplace controlled launch**: community extension submissions are technically accepted, but every submission lands `pending` and stays there until an admin approves manually via `apps.zveltio.com/admin/marketplace/*` or the `zveltio admin marketplace` CLI. The review team and SLA are documented as operator decisions in [`docs/MARKETPLACE-POLICY.md`](docs/MARKETPLACE-POLICY.md) §9.

**Production stability**: the underlying stack (Postgres + Bun + Hono + Better-Auth + Casbin) is production-mature. We test on every commit (399 unit + 148 integration tests in CI).

**Alpha track EOL**: `1.0.0-alpha.*` is **closed** as of beta.1 (2026-05-31). Last alpha: **alpha.129**. We do not publish new alpha tags; releases stay on GitHub for audit only. **Install beta** (`get.zveltio.com`) or run `zveltio update --version 3.0.0-beta.31`. Full policy: [docs/ALPHA-TRACK-EOL.md](docs/ALPHA-TRACK-EOL.md).

**Migration from alpha**: see [docs/MIGRATION-ALPHA-TO-BETA.md](docs/MIGRATION-ALPHA-TO-BETA.md). If you ran any alpha.111+ release you'll auto-migrate cleanly; for older alpha-track installs the migration is one-way.

**v1.0 target**: tracked in [docs/REFACTORING-V1-PLAN.md](docs/REFACTORING-V1-PLAN.md) (extension platform: ✅ done at beta.1; remaining v1.0 work is product/GTM — benchmarks, demo.zveltio.com, case studies).

---

## License

MIT — see [LICENSE](LICENSE). No per-seat fees, no commercial restriction, no source-available bait-and-switch.

If you build something on Zveltio that helps your business, the only thing we ask is a star ⭐ on this repo and — if you can spare it — a write-up so others know it's viable.

---

## The platform behind your business. Build it. Plug it in. Own it forever.

Zveltio is a product of [DaRe IT Systems S.R.L.](https://dareit.ro) — based in Romania, open to the world.

**[Read the docs →](https://zveltio.com/intro)** · **[Join the community →](https://github.com/zveltio-devs/zveltio/discussions)** · **[Report an issue →](https://github.com/zveltio-devs/zveltio/issues)**
