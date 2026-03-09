# 🏗️ Zveltio Architecture

Complete technical architecture documentation for Zveltio, adapted for the Bun runtime.

---

## Table of Contents

- [System Overview](#system-overview)
- [Component Architecture](#component-architecture)
- [Data Flow](#data-flow)
- [Authentication & Authorization](#authentication--authorization)
- [Technology Stack](#technology-stack)

---

## System Overview

Zveltio is a **distributed, headless BaaS platform** designed for enterprises and public institutions. The system follows a **modular monolith architecture** with clear separation of concerns.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Internet/Intranet                           │
└────────────────────────┬────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ↓                     ↓
┌──────────────────────┐  ┌──────────────────────┐
│   Zveltio Studio     │  │   Zveltio Client     │
│   (Admin Interface)  │  │   (Public Frontend)  │
│   Port: 5173         │  │   Port: 5174         │
│   SvelteKit          │  │   SvelteKit          │
└──────────┬───────────┘  └──────────┬───────────┘
           │                         │
           └──────────┬──────────────┘
                      │ REST API + Hono RPC
                      ↓
           ┌────────────────────────┐
           │    Zveltio Engine      │
           │    (API Gateway)       │
           │    Port: 3000          │
           │    Bun + Hono + Kysely  │
           └──────────┬─────────────┘
                      │
          ┌───────────┼───────────┐
          ↓           ↓           ↓
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│  PostgreSQL  │ │  Valkey  │ │  SeaweedFS   │
│  (Database)  │ │ (Cache)  │ │  (Storage)   │
│  Port: 5432  │ │Port: 6379│ │  Port: 8333  │
│  + pgvector  │ │          │ │  (S3 API)    │
└──────────────┘ └──────────┘ └──────────────┘
```

### Core Principles

1. **Separation of Concerns** - Each component has a single, well-defined responsibility
2. **API-First** - All functionality exposed through REST API
3. **Type Safety** - End-to-end TypeScript with Hono RPC
4. **Scalability** - Horizontal scaling support for all components
5. **Security** - Defense in depth with multiple security layers
6. **Flexibility** - Plugin-based architecture for extensions

---

## Architecture Philosophy

Zveltio Engine is intentionally designed as a **modular monolith** — a single deployable process with clear internal module boundaries.

### Why Modular Monolith?

**For self-hosting (primary use case):**

- Single process = single deployment, single monitoring target, simple Docker setup
- No network latency between internal services
- No distributed tracing complexity
- Easier debugging — one log stream, one process

**Internal modularity:**

Each subsystem is isolated in its own module with clear boundaries:

- `packages/engine/src/routes/` — HTTP layer, one file per domain
- `packages/engine/src/lib/` — Business logic, independently testable
- `extensions/*/engine/` — Extension-specific logic

---

## Component Architecture

### Zveltio Engine

**Role:** Core API server and business logic orchestrator

#### Internal Architecture

```
packages/engine/
├── src/
│   ├── index.ts                    # Server entry point (Bun)
│   ├── lib/
│   │   ├── auth.ts                 # Better-Auth config
│   │   ├── permissions.ts          # Casbin RBAC + God user (isGodUser, invalidateGodCache)
│   │   ├── cache.ts                # Valkey/Redis client (ioredis)
│   │   ├── webhooks.ts             # Webhook manager
│   │   ├── webhook-worker.ts       # Async webhook processor
│   │   ├── ai-provider.ts          # Multi-provider AI integration
│   │   ├── flow-executor.ts        # Automation flows with AI decision steps
│   │   ├── ddl-manager.ts          # Dynamic DDL (collections)
│   │   ├── ddl-queue.ts            # Async DDL job queue
│   │   ├── validation-engine.ts    # Field validation
│   │   ├── cloud/
│   │   │   └── document-indexer.ts # Shared text extraction utility (PDF, Office, HTML)
│   │   └── edge-functions/         # Edge function sandbox (moved from extension)
│   │       ├── sandbox.ts          # Worker spawn + timeout/memory watchdogs
│   │       └── worker-runner.ts    # SSRF protection, global scope isolation
│   ├── db/
│   │   ├── index.ts                # Kysely connection
│   │   ├── dynamic.ts              # Dynamic query builder
│   │   └── migrations/             # 47 SQL migrations (001–047)
│   ├── routes/
│   │   ├── index.ts                # Route registration (all routes)
│   │   ├── auth.ts / users.ts      # Auth + user management
│   │   ├── collections.ts          # Collection schema management
│   │   ├── data.ts                 # Generic CRUD (session + API key)
│   │   ├── relations.ts            # Table relationships
│   │   ├── storage.ts / media.ts   # File storage + media library
│   │   ├── permissions.ts          # RBAC endpoints
│   │   ├── webhooks.ts             # Webhook management
│   │   ├── flows.ts                # Automation flows
│   │   ├── approvals.ts            # Approval workflows
│   │   ├── ai.ts                   # Chat, embeddings, providers
│   │   ├── ai-search.ts            # Semantic vector search
│   │   ├── edge-functions.ts       # Edge function CRUD + dynamic mounting
│   │   ├── graphql.ts              # Auto-generated GraphQL + playground
│   │   ├── schema-branches.ts      # Schema development branches
│   │   ├── introspect.ts           # External DB schema import (BYOD)
│   │   ├── sync.ts                 # SDK local-first sync
│   │   ├── export.ts / import.ts   # PDF/Excel/CSV export + bulk import
│   │   ├── backup.ts               # Database backups
│   │   ├── tenants.ts              # Multi-tenancy
│   │   ├── gdpr.ts                 # GDPR compliance
│   │   └── ...                     # + insights, quality, validation, saved-queries, etc.
│   └── middleware/
│       ├── rate-limit.ts           # Auth/API/AI rate limiting
│       └── tenant.ts               # Tenant isolation
├── package.json                    # Bun dependencies
└── tsconfig.json                   # TypeScript config
```

#### Technology Stack

| Layer             | Technology  | Purpose                     |
| ----------------- | ----------- | --------------------------- |
| **Runtime**       | Bun 1.2.0   | JavaScript runtime          |
| **Framework**     | Hono 4.4    | Ultra-fast web framework    |
| **Database**      | Kysely 0.27 | Type-safe SQL query builder |
| **Auth**          | Better-Auth | Complete auth solution      |
| **Authorization** | Casbin 5.30 | RBAC/ABAC engine            |
| **Cache**         | ioredis     | Redis-protocol client connecting to Valkey (Valkey is Redis-compatible, open-source; ioredis chosen for maturity — Valkey's own client ecosystem is nascent) |
| **Storage**       | AWS SDK S3  | S3-compatible storage       |
| **Validation**    | Zod         | Schema validation           |

---

### Zveltio CLI

**Role:** Command-line tools for project management

#### Commands

```bash
# Initialize new project
zveltio init

# Create God (super-admin) user
zveltio create-god --url http://localhost:3000

# Run database migrations
zveltio migrate

# Development server
zveltio dev

# Build for production
zveltio build

# Start production server
zveltio start
```

---

### Zveltio Studio

**Role:** Admin interface for system configuration

#### Technology Stack

| Layer          | Technology         | Purpose                |
| -------------- | ------------------ | ---------------------- |
| **Framework**  | SvelteKit 2        | Full-stack framework   |
| **UI Library** | Svelte 5           | Reactive UI components |
| **Styling**    | TailwindCSS        | Utility-first CSS      |
| **Icons**      | Lucide Svelte      | Icon library           |
| **API Client** | Hono RPC           | Type-safe API client   |
| **Auth**       | Better-Auth Client | Authentication         |

---

### Zveltio SDK

**Role:** Client-side integration library

#### Supported Frameworks

- **Vanilla JS/TypeScript** (`@zveltio/sdk`) - Core client with offline sync
- **React 18+** (`@zveltio/react`) - Hooks: `useCollection`, `useRecord`, `useSyncCollection`, `useSyncStatus`, `useRealtime`, `useAuth`, `useStorage`
- **Vue 3.3+** (`@zveltio/vue`) - Composables with the same API surface, compatible with `<script setup>`

#### Features

- Type-safe API client (Hono RPC)
- Real-time subscriptions (WebSocket)
- Authentication helpers
- Local-first offline sync (IndexedDB via `idb`)

---

## Data Flow

### 1. Authentication Flow

```
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│  Client  │                 │  Engine  │                 │PostgreSQL│
└─────┬────┘                 └─────┬────┘                 └─────┬────┘
      │                            │                            │
      │  POST /api/auth/sign-in    │                            │
      │─────────────────────────>  │                            │
      │  {email, password}         │                            │
      │                            │  SELECT user WHERE email   │
      │                            │───────────────────────────>│
      │                            │                            │
      │                            │  <user data>               │
      │                            │<───────────────────────────│
      │                            │                            │
      │                            │  Verify password           │
      │                            │  Create session            │
      │                            │  INSERT session            │
      │                            │───────────────────────────>│
      │                            │                            │
      │  <session cookie>          │                            │
      │<──────────────────────────│                            │
      │                            │                            │
```

### 2. CRUD Operation Flow (with RBAC)

```
┌──────────┐                 ┌──────────┐                 ┌──────────┐
│  Studio  │                 │  Engine  │                 │PostgreSQL│
└─────┬────┘                 └─────┬────┘                 └─────┬────┘
      │                            │                            │
      │  POST /api/data/products   │                            │
      │─────────────────────────>  │                            │
      │  Cookie: session-xyz       │                            │
      │  Body: {name: "Product"}  │                            │
      │                            │                            │
      │                            │  1. Verify session         │
      │                            │  SELECT session            │
      │                            │───────────────────────────>│
      │                            │  <session data>            │
      │                            │<───────────────────────────│
      │                            │                            │
      │                            │  2. Check permissions      │
      │                            │  (Casbin + Emergency Admin)│
      │                            │                            │
      │                            │  3. INSERT INTO products   │
      │                            │───────────────────────────>│
      │                            │                            │
      │                            │  <new record>              │
      │                            │<───────────────────────────│
      │                            │                            │
      │                            │  4. Trigger webhooks       │
      │                            │  (async, if configured)    │
      │                            │                            │
      │  {record: {...}}           │                            │
      │<───────────────────────────│                            │
      │                            │                            │
```

---

## Authentication & Authorization

### Authentication (Better-Auth)

**Components:**

- Session-based authentication
- Cookie storage (secure, httpOnly, sameSite)
- Password hashing (bcrypt)
- Email verification
- 2FA support (TOTP)
- OAuth providers (Google, GitHub, etc.)

### Authorization (Casbin + Emergency Admin Access)

**Casbin Policies:**

```csv
# p, subject, resource, action, scope
p, admin, *, *, ALL
p, manager, data, read, ORGANIZATION
p, employee, data, read, OWN
```

**Emergency Admin Access:**

Zveltio has a special **Emergency Admin Access** that provides unlimited access regardless of Casbin policies. This is a disaster recovery mechanism — equivalent to Supabase's `service_role` key:

```typescript
// In permissions.ts
const isGod = result.rows[0]?.role === 'god';
if (isGod) return true; // Emergency Admin bypass — all Casbin checks skipped
```

This allows creating a Super-Admin user with the CLI:

```bash
bun run packages/cli/src/index.ts create-god
```

---

## Technology Stack

### Core Technologies

| Category      | Technology      | Version | Purpose                            |
| ------------- | --------------- | ------- | ---------------------------------- |
| Runtime       | Bun             | 1.2.0   | JavaScript/TypeScript runtime      |
| Framework     | Hono            | 4.4.0   | Web framework                      |
| Database      | PostgreSQL      | 17      | Primary database + pgvector        |
| ORM           | Kysely          | 0.27.6  | Type-safe query builder            |
| Pool          | PgBouncer       | latest  | Transaction-level connection pool  |
| Cache         | Valkey          | 8       | Redis-compatible cache             |
| Cache client  | ioredis         | 5.3.2   | Valkey/Redis client                |
| Auth          | Better-Auth     | 1.3.34  | Authentication                     |
| RBAC          | Casbin          | 5.30.0  | Authorization                      |
| Storage       | SeaweedFS       | 3.68    | S3-compatible object storage       |
| GraphQL       | graphql-yoga    | 5.x     | Auto-generated GraphQL API         |
| Batching      | dataloader      | 2.x     | N+1 query prevention               |
| Telemetry     | OpenTelemetry   | 1.9.0   | Distributed tracing                |
| UI            | SvelteKit       | 2.x     | Admin + public interfaces          |
| UI components | DaisyUI         | 5.x     | Component library                  |
| Validation    | Zod             | 4.x     | Schema validation                  |
| PDF           | pdfkit          | 0.15    | PDF export                         |

### Infrastructure

| Service    | Image                    | Ports      |
| ---------- | ------------------------ | ---------- |
| PostgreSQL | pgvector/pg17            | 5432       |
| PgBouncer  | edoburu/pgbouncer        | 6432       |
| Valkey     | valkey/valkey:8          | 6379       |
| SeaweedFS  | chrislusf/seaweedfs:3.68 | 8333, 8888 |
| Prometheus | prom/prometheus          | 9090       |
| Grafana    | grafana/grafana          | 3001       |

---

## Extensions System

Zveltio supports a plugin-based architecture through extensions:

```
extensions/
├── ai/                     # AI extensions
│   └── core-ai/           # Chat, alchemist, query, schema-gen (AI features beyond engine core)
├── automation/            # Workflow automation
│   └── flows/            # Flow executor with DLQ retry
├── communications/        # Communication channels
│   └── mail/             # IMAP/SMTP mail client with AI features and Sieve filtering
├── compliance/           # Regional compliance
│   └── ro/
│       ├── documents/    # Romanian compliance documents
│       ├── efactura/     # eFactura (e-invoicing)
│       └── procurement/  # Public procurement
├── content/              # Content management
│   ├── page-builder/    # CMS pages + Studio editor
│   └── document-templates/ # HTML/PDF template management
├── developer/            # Developer tools
│   └── edge-functions/  # Studio UI only (engine sandbox is in core)
├── geospatial/           # Geographic data
│   └── postgis/         # PostGIS field types + queries
├── storage/              # External storage adapters
│   └── cloud/           # S3-compatible file versioning, trash, public share links
└── workflow/             # Workflow management
    ├── approvals/
    └── checklists/
```

> **Architecture note:** The edge function _sandbox runtime_ (`lib/edge-functions/`) lives in the engine core for security isolation and performance. The `developer/edge-functions` extension only provides the Studio admin UI; the engine manages `zv_edge_functions` tables and `GET /api/edge-functions`, `POST /api/fn/*` routes.

Each extension follows the structure:

- `manifest.json` - Extension metadata (name, category, version, permissions, contributes)
- `engine/` - Backend routes, business logic, and SQL migrations (optional)
- `studio/` - Admin UI components (SvelteKit 5, optional)

### Notable Extension Capabilities

| Extension              | Key Feature                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `flows`                | DLQ with exponential backoff retry, idempotency via SHA-256                            |
| `core-ai`              | Alchemist (documents → DB), Text-to-SQL, Prompt → Schema, native tool-calling AI chat  |
| `communications/mail`  | Full IMAP/SMTP mail client, Sieve filters, AI compose and reply                        |
| `storage/cloud`        | S3 file versioning, soft-delete trash bin, public token-based share links              |
| `content/page-builder` | CMS pages with Tiptap editor, slug routing, i18n                                       |
| `postgis`              | Custom field types: `location`, `polygon`, `linestring`                                |
