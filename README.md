# 🚀 Zveltio

**High-performance Headless BaaS (Backend as a Service)** built with Bun, Hono, Kysely, Better-Auth, and Casbin. Zveltio is a modern, self-hosted platform designed for enterprises and public institutions.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.2.0+-red)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)

---

## ✨ Key Features

- 🚄 **Ultra-Fast API** - Built on Hono with Bun runtime for maximum performance
- 🔧 **Dynamic Collections** - Create and manage database tables at runtime without migrations
- 🔐 **Complete Authentication** - Better-Auth with session management, OAuth, 2FA
- 🛡️ **Granular Authorization** - RBAC/ABAC powered by Casbin with God bypass
- 🤖 **AI Integration** - Universal provider support (OpenAI, Anthropic, Ollama, Azure OpenAI, Custom)
- 🧠 **AI Assistant** - Conversational AI with native tool-calling (query data, create collections, generate reports)
- 🔍 **Semantic Search** - RAG-powered vector similarity search with pgvector
- 🗣️ **Text-to-SQL** - AI copilot that converts natural language to SQL queries
- ⚗️ **Data Alchemist** - Convert unstructured documents into structured database collections
- 📊 **Universal Export** - Generate PDF, Excel, CSV from any collection
- 🪝 **Webhooks** - Event-driven HTTP notifications
- 🔄 **Automation Flows** - Visual workflow builder with DLQ retry and idempotency
- 📬 **Mail Client** - Full IMAP/SMTP integration with AI features and Sieve filtering
- ☁️ **Cloud Storage** - File versioning, trash bin, and public share links
- 🌍 **i18n Support** - Built-in translation system
- 📈 **Monitoring** - Prometheus metrics & Grafana dashboards
- 🎯 **Type-Safe** - Full TypeScript with Hono RPC client
- 🔄 **Zero-Downtime Migrations** - Ghost DDL algorithm for large tables (100k+ rows)
- 🏗️ **Extensions** - Plugin system for custom functionality
- 🌐 **GraphQL** - Auto-generated read-only GraphQL API with playground
- 🔀 **Schema Branches** - Safe schema development without affecting production
- 🏢 **Multi-Tenancy** - Built-in tenant registry with environment isolation

---

## 🏗️ Architecture

Zveltio uses a **monorepo architecture** with Turborepo:

```
zveltio/
├── packages/
│   ├── engine/        # Core API server (Bun + Hono + Kysely)
│   ├── cli/           # CLI tools (create-god, init, dev)
│   ├── sdk/           # Vanilla JS/TypeScript client
│   ├── sdk-react/     # React 18+ hooks (@zveltio/react)
│   ├── sdk-vue/       # Vue 3 composables (@zveltio/vue)
│   ├── studio/        # Admin UI (SvelteKit 5)
│   └── client/        # Public-facing app (SvelteKit 5)
├── extensions/        # Plugin system
│   ├── ai/           # AI extensions
│   ├── automation/   # Flows
│   ├── compliance/   # Romanian compliance (eFactura)
│   ├── content/      # Page builder
│   ├── developer/    # Edge functions
│   ├── geospatial/   # PostGIS
│   └── workflow/     # Approvals, checklists
└── docker-compose.yml
```

### Technology Stack

| Layer             | Technology      | Purpose                      |
| ----------------- | --------------- | ---------------------------- |
| **Runtime**       | Bun 1.2.0       | JavaScript runtime           |
| **Framework**     | Hono 4.4        | Ultra-fast web framework     |
| **Database**      | Kysely 0.27     | Type-safe SQL query builder  |
| **DB Engine**     | PostgreSQL 17   | Primary database + pgvector  |
| **Auth**          | Better-Auth 1.3 | Complete auth solution       |
| **Authorization** | Casbin 5.30     | RBAC/ABAC engine             |
| **Cache**         | Valkey 8        | Redis-compatible cache       |
| **Storage**       | SeaweedFS       | S3-compatible object storage |
| **UI**            | SvelteKit 2     | Admin interface              |

---

## 🚀 Quick Start

### Prerequisites

- **Bun** >= 1.2.0
- **Docker** & **Docker Compose**
- **Git**

### Installation

```bash
# Clone repository
git clone https://github.com/your-org/zveltio.git
cd zveltio

# Install dependencies
bun install
```

### Start Infrastructure (Database, Cache, Storage)

```bash
# Start all services with Docker
docker compose up -d

# This starts:
# - PostgreSQL (port 5432)
# - PgBouncer (port 6432)
# - Valkey (port 6379)
# - SeaweedFS (port 8333)
# - Prometheus (port 9090)
# - Grafana (port 3001)
```

### Environment Configuration

Create `.env` file:

```bash
cp .env.example .env
```

**Essential Configuration:**

```env
# Server
PORT=3000
NODE_ENV=development

# Database (via PgBouncer)
DATABASE_URL=postgresql://zveltio:zveltio@localhost:6432/zveltio

# Cache (Valkey)
REDIS_URL=redis://:zveltio@localhost:6379

# Authentication
BETTER_AUTH_SECRET=your-ultra-secure-secret-minimum-32-chars
BETTER_AUTH_URL=http://localhost:3000

# Storage (SeaweedFS/S3)
S3_ENDPOINT=http://localhost:8333
S3_REGION=us-east-1
S3_BUCKET=zveltio
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_PUBLIC_URL=http://localhost:8333
```

### Initialize Database

```bash
# Run migrations and seed data
bun run -T packages/engine/src/db/migrate.ts
```

### Create First Admin User

```bash
# Create God (super-admin) user
bun run packages/cli/src/index.ts create-god

# Follow interactive prompts:
# Email: admin@your-company.com
# Password: ********
# Name: System Admin
```

### Start Development

```bash
# Start Engine (API)
bun --watch packages/engine/src/index.ts

# In another terminal, start Studio (Admin UI)
cd packages/studio && bun run dev
```

**Access Points:**

- **Engine API:** http://localhost:3000
- **Studio (Admin):** http://localhost:5173

---

## 📦 Packages

### @zveltio/engine

Core API server with:

- Dynamic Collections (no migrations needed) and Ghost DDL zero-downtime migrations
- Better-Auth authentication + Casbin RBAC with God bypass (Emergency Admin Access)
- AI integration: multi-provider support (OpenAI, Anthropic, Ollama, Azure, Custom), semantic vector search, AI assistant with native tool-calling
- Sandboxed Edge Functions: Bun Worker-based runtime with SSRF protection, 64 MB memory watchdog, and global scope isolation
- Webhooks, real-time SSE, GraphQL auto-API, schema branches, multi-tenancy, BYOD introspection
- Export (PDF, Excel, CSV), local-first SDK sync, approval workflows, GDPR compliance

### @zveltio/cli

Command-line tools:

- `init` - Initialize new project
- `create-god` - Create super-admin user
- `migrate` - Database migrations
- `dev` / `build` / `start` - Server management
- `extension` - Extension management

### @zveltio/sdk

Vanilla JS/TypeScript client with:

- Type-safe collection CRUD, auth, storage helpers
- Real-time subscriptions (WebSocket)
- Local-first offline sync (IndexedDB)

### @zveltio/react

React 18+ hooks wrapper:

- `useCollection`, `useRecord`, `useSyncCollection`, `useSyncStatus`
- `useRealtime`, `useAuth`, `useStorage`
- SSR-safe, peer dependency: React ≥ 18

### @zveltio/vue

Vue 3 composables wrapper:

- `useCollection`, `useRecord`, `useSyncCollection`, `useSyncStatus`
- `useRealtime`, `useAuth`, `useStorage`
- Compatible with `<script setup>`, peer dependency: Vue ≥ 3.3

### @zveltio/studio

Admin interface (SvelteKit 5):

- Collection & field management
- User & permission management
- AI configuration and assistant
- Webhook management
- Automation flows builder with DLQ management
- Content editing with rich text editor
- Analytics dashboards and insights
- Mail client, cloud storage, and document templates

### @zveltio/client

Public-facing SvelteKit 5 application:

- Authentication flows (sign-in, sign-up, OAuth)
- Public data entry and viewing
- Real-time updates via WebSocket
- Maps support via Leaflet

---

## 🤖 AI Integration

Zveltio includes a **universal AI provider system** with zero external dependencies:

### Supported Providers

- ✅ **OpenAI** (GPT-4, GPT-3.5)
- ✅ **Anthropic** (Claude 3 Opus/Sonnet/Haiku)
- ✅ **Ollama** (Self-hosted LLMs)
- ✅ **Azure OpenAI**
- ✅ **Custom Providers** (any OpenAI-compatible API)

### AI Features

| Feature                      | Description                     | API Endpoint                    |
| ---------------------------- | ------------------------------- | ------------------------------- |
| 🤖 **Chat Assistant**        | Context-aware conversations     | `POST /api/ai/chat`             |
| 🔍 **Semantic Search**       | RAG-powered document search     | `POST /api/ai/search`           |
| 📄 **Document Intelligence** | Extract insights from documents | `POST /api/ai/document/analyze` |
| 📊 **Data Insights**         | AI-powered collection analysis  | `POST /api/ai/insights`         |
| 🌐 **Translation**           | Context-aware translation       | `POST /api/ai/translate`        |

### Quick AI Setup

```bash
# Add API key to .env
echo "OPENAI_API_KEY=sk-your-key" >> .env

# Restart engine
bun --watch packages/engine/src/index.ts
```

---

## 📚 API Endpoints

### Core APIs

| Category              | Endpoint                      | Description                            |
| --------------------- | ----------------------------- | -------------------------------------- |
| **Auth**              | `/api/auth/*`                 | Better-Auth endpoints                  |
| **Me**                | `/api/me`                     | Profile & session convenience          |
| **Collections**       | `/api/collections`            | Dynamic table management               |
| **Data**              | `/api/data/:collection`       | CRUD operations                        |
| **Relations**         | `/api/relations`              | Table relationships                    |
| **Revisions**         | `/api/revisions`              | Record history & comments              |
| **Drafts**            | `/api/drafts`                 | Draft/publish workflow                 |
| **Storage**           | `/api/storage`                | File upload/download (S3)              |
| **Media**             | `/api/media`                  | Media library with folders & tags      |
| **Export**            | `/api/export/:collection`     | PDF/Excel/CSV generation               |
| **Import**            | `/api/import`                 | CSV/JSON bulk import                   |
| **Permissions**       | `/api/permissions`            | Casbin RBAC management                 |
| **Users**             | `/api/users`                  | User management                        |
| **Webhooks**          | `/api/webhooks`               | Event-driven notifications             |
| **Translations**      | `/api/translations`           | i18n management                        |
| **Notifications**     | `/api/notifications`          | In-app & web push notifications        |
| **Realtime**          | `/api/realtime`               | SSE stream for live updates            |
| **Flows**             | `/api/flows`                  | Automation workflow CRUD + trigger     |
| **Approvals**         | `/api/approvals`              | Multi-step approval workflows          |
| **Edge Functions**    | `/api/edge-functions`         | Serverless function CRUD + invoke      |
| **Edge Fn Runtime**   | `/api/fn/:name`               | Invoke deployed edge function          |
| **Sync**              | `/api/sync`                   | SDK local-first push/pull operations   |
| **Insights**          | `/api/insights`               | Analytics dashboards & panels          |
| **Saved Queries**     | `/api/saved-queries`          | Reusable query builder                 |
| **Validation**        | `/api/validation`             | Data validation rules                  |
| **Quality**           | `/api/quality`                | Data quality dashboard                 |
| **Documents**         | `/api/documents`              | Compliance document generation         |
| **Settings**          | `/api/settings`               | System configuration                   |
| **Admin**             | `/api/admin`                  | API keys, audit logs, onboarding       |
| **Database**          | `/api/database`               | Functions, triggers, enums, RLS        |
| **Backup**            | `/api/backup`                 | Database backup management             |
| **Tenants**           | `/api/tenants`                | Multi-tenancy registry                 |
| **Schema**            | `/api/schema`                 | Schema branches for safe development   |
| **Introspect**        | `/api/introspect`             | External DB schema import (BYOD)       |
| **Marketplace**       | `/api/marketplace`            | Extension marketplace                  |
| **GraphQL**           | `/api/graphql`                | Auto-generated GraphQL API             |
| **API Docs**          | `/api/docs`                   | Swagger UI + OpenAPI spec              |
| **GDPR**              | `/api/gdpr`                   | GDPR compliance endpoints              |
| **Sitemap**           | `/api/sitemap.xml`            | CMS page sitemap (public)              |

### Extension-Provided APIs

These endpoints are available when the corresponding extension is enabled:

| Extension              | Endpoint                  | Description                           |
| ---------------------- | ------------------------- | ------------------------------------- |
| `communications/mail`  | `/api/mail`               | IMAP/SMTP mail client                 |
| `storage/cloud`        | `/api/cloud`, `/share/:token` | File versioning, trash, public share |
| `content/page-builder` | `/api/cms/pages`          | CMS pages                             |
| `content/document-templates` | `/api/document-templates` | HTML/PDF template management  |
| `ai/core-ai`           | `/api/ai/alchemist`       | Documents → structured database       |
| `ai/core-ai`           | `/api/ai/query`           | Text-to-SQL copilot                   |
| `ai/core-ai`           | `/api/ai` (schema-gen)    | Prompt → schema generator             |
| `automation/flows`     | `/api/flows`              | Automation workflows                  |

### AI APIs (Engine Core)

| Endpoint                      | Method | Description                               |
| ----------------------------- | ------ | ----------------------------------------- |
| `/api/ai/chat`                | POST   | Conversational AI with tool-calling       |
| `/api/ai/search`              | POST   | Semantic vector similarity search         |
| `/api/ai/embeddings/generate` | POST   | Generate single embedding                 |
| `/api/ai/embeddings/batch`    | POST   | Batch generate embeddings                 |
| `/api/ai/usage/me`            | GET    | User AI usage statistics                  |
| `/api/ai/providers`           | GET    | List available AI providers               |

---

## 🛠️ Development

### Available Scripts

```bash
# Install
bun install

# Development
bun run dev              # Start all services with turbo
bun run -T packages/engine/src/index.ts  # Engine only
cd packages/studio && bun run dev        # Studio only

# Build
bun run build            # Build all packages
bun run build:binary    # Build single binary

# Database
bun run -T packages/engine/src/db/migrate.ts

# Testing
bun run test             # Run all tests
bun run test packages/engine  # Engine tests only
bun run test packages/cli    # CLI tests only

# Linting
bun run lint
```

---

## 🔐 Security

- 🔒 **Better-Auth** - Secure authentication with session management
- 🛡️ **Casbin RBAC** - Fine-grained permission control
- 🚦 **Rate Limiting** - Protect against abuse
- 🔑 **API Keys** - Secure service-to-service communication
- 🌐 **CORS** - Configurable cross-origin policies
- 🔐 **SQL Injection Protection** - Parameterized queries with Kysely
- 👑 **God Bypass** - Special role with unlimited access (role='god')

---

## 📊 Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2026-03-04T18:00:00.000Z",
  "services": {
    "database": "connected",
    "cache": "connected",
    "storage": "connected"
  }
}
```

### Prometheus Metrics

```bash
curl http://localhost:3000/metrics
```

### Grafana Dashboards

Access Grafana at http://localhost:3001 (default: admin/admin)

---

## 🐛 Troubleshooting

### Cannot connect to database

```bash
# Check PostgreSQL status
docker compose ps db

# Check logs
docker compose logs db

# Test connection
psql -h localhost -p 5432 -U zveltio -d zveltio
```

### Cannot connect to cache

```bash
# Check Valkey status
docker compose ps cache

# Test connection
docker compose exec cache valkey-cli -a zveltio PING
# Expected: PONG
```

### AI providers not loading

```bash
# Check AI configuration in database
# Navigate to Studio: http://localhost:5173/admin/ai

# Check logs for errors
docker compose logs engine
```

---

## 📖 Documentation

- 📘 [Quick Start](#-quick-start) - Get started
- 🏗️ [Architecture](docs/ARCHITECTURE.md) - System design
- 🔐 [Authorization](docs/AUTHORIZATION.md) - RBAC & God bypass
- 📦 [Packages](#-packages) - SDK, CLI, Studio
- 🚀 [Installation](docs/INSTALLATION.md) - Setup guide
- 🌍 [Ecosystem](docs/ECOSYSTEM.md) - Platform overview
- 🔒 [Security](docs/SECURITY.md) - Security hardening
- 📦 [Extensions](docs/EXTENSIONS.md) - Plugin system
- 🔄 [Ghost DDL](docs/GHOST-DDL.md) - Zero-downtime migrations
- 📚 [Documentation Index](docs/DOCUMENTATION_INDEX.md) - All docs
- ⚖️ [Horizontal Scaling & HA](docs/HORIZONTAL_SCALING.md) - Enterprise Deployment Guide

---

## 🌍 Ecosystem

Zveltio is part of a complete BaaS platform:

| Repository         | Description                |
| ------------------ | -------------------------- |
| **zveltio** (this) | Monorepo with all packages |
| **extensions/**    | Built-in extensions        |

---

## 📝 License

ISC License - See [LICENSE](LICENSE) file for details.

---

## 🤝 Support

- 📧 Email: support@zveltio.com
- 🐛 Issues: [GitHub Issues](https://github.com/your-org/zveltio/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/your-org/zveltio/discussions)

---

**Built with ❤️ for Enterprises and Public Institutions**
