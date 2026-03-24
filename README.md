# 🚀 Zveltio

**High-performance self-hosted BaaS (Backend as a Service)** built with Bun, Hono, Kysely, Better-Auth, and Casbin. Designed for enterprises and public institutions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.2.0+-red)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)

---

## ⚡ Quick Install

```bash
curl -fsSL https://get.zveltio.com/install.sh | bash
```

Full installation guide: **[get.zveltio.com](https://get.zveltio.com)**

---

## ✨ Key Features

- 🔧 **Dynamic Collections** — Create database tables at runtime, no migrations needed
- 🔐 **Authentication** — Better-Auth: sessions, OAuth, 2FA, API keys
- 🛡️ **RBAC / ABAC** — Casbin with God bypass (Emergency Admin)
- 🤖 **AI Native** — OpenAI, Anthropic, Ollama, Azure; semantic search, Text-to-SQL, Data Alchemist
- 🔄 **Automation Flows** — Visual builder, DLQ retry, idempotency
- 📬 **Mail Client** — IMAP/SMTP with Sieve filters and AI compose
- ☁️ **Cloud Storage** — SeaweedFS S3-compatible, file versioning, trash, public share links
- 🔀 **Zero-Downtime Migrations** — Ghost DDL algorithm (auto-activated for tables > 100k rows)
- 🧩 **Extensions** — Plugin system with marketplace
- 🌐 **GraphQL** — Auto-generated read-only API
- 🏢 **Multi-Tenancy** — Built-in tenant registry with environment isolation
- 🔁 **Real-time** — WebSocket + PostgreSQL LISTEN/NOTIFY
- 📊 **Export** — PDF, Excel, CSV from any collection
- 🌍 **i18n** — Built-in translation system

---

## 🏗️ Architecture

Monorepo with Turborepo:

```
zveltio/                   # This repo — core engine
├── packages/
│   ├── engine/            # Core API server (Bun + Hono + Kysely)
│   ├── cli/               # CLI (zveltio start, migrate, update, create-god...)
│   ├── sdk/               # Vanilla JS/TypeScript client
│   ├── sdk-react/         # React 18+ hooks (@zveltio/react)
│   ├── sdk-vue/           # Vue 3 composables (@zveltio/vue)
│   └── studio/            # Admin UI (SvelteKit 5)
├── Dockerfile
├── docker-compose.yml
└── scripts/
    ├── install.sh
    └── generate-compose.sh

zveltio-extensions/        # Separate repo — marketplace extensions
├── analytics/             # Insights dashboards
├── auth/                  # LDAP, SAML
├── communications/        # Mail (IMAP/SMTP)
├── compliance/            # GDPR, eFactura, SAF-T (RO)
├── content/               # Page builder, document templates
├── developer/             # Edge functions, GraphQL, views
├── geospatial/            # PostGIS field types
├── storage/               # Cloud storage (S3)
└── workflow/              # Approvals, checklists
```

### Technology Stack

| Layer         | Technology      | Purpose                          |
| ------------- | --------------- | -------------------------------- |
| Runtime       | Bun 1.2.0       | JavaScript/TypeScript runtime    |
| Framework     | Hono 4.4        | Ultra-fast web framework         |
| Database      | PostgreSQL 17   | Primary DB + pgvector            |
| ORM           | Kysely 0.27     | Type-safe query builder          |
| Pool          | PgBouncer       | Connection pooler                |
| Cache         | Valkey 8        | Redis-compatible cache           |
| Auth          | Better-Auth     | Authentication                   |
| RBAC          | Casbin 5.30     | Authorization                    |
| Storage       | SeaweedFS 3.68  | S3-compatible object storage     |
| UI            | SvelteKit 5     | Admin interface (Studio)         |

---

## 🛠️ Development Setup

For contributors and extension developers:

```bash
git clone https://github.com/zveltio-devs/zveltio.git
cd zveltio
bun install

# Start infrastructure (PostgreSQL, Valkey, SeaweedFS)
docker compose -f docker-compose.infra.yml up -d

# Configure environment
cp .env.example .env

# Run migrations
zveltio migrate

# Start engine with hot reload
zveltio dev

# Start Studio (separate terminal)
cd packages/studio && bun run dev
```

**Access:**
- Engine API: http://localhost:3000
- Studio: http://localhost:5173

---

## 📦 CLI Commands

```bash
zveltio start           # Start in production mode
zveltio dev             # Start with hot reload
zveltio migrate         # Run pending migrations
zveltio create-god      # Create super-admin
zveltio update          # Update to latest version
zveltio install <ext>   # Install extension
zveltio generate-types  # Generate TypeScript types
```

---

## 📖 Documentation

Full documentation at **[zveltio.com/docs](https://zveltio.com/docs)**

---

## 📝 License

MIT — See [LICENSE](LICENSE)

---

Zveltio is a product of [DaRe IT Systems S.R.L.](https://dareit.ro)
