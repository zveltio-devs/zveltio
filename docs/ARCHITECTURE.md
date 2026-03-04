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
│   │   ├── permissions.ts          # Casbin RBAC + God bypass
│   │   ├── cache.ts                # Valkey/Redis client
│   │   ├── webhooks.ts             # Webhook manager
│   │   ├── webhook-worker.ts       # Async webhook processor
│   │   ├── ai-provider.ts         # AI integration
│   │   ├── tenant-manager.ts       # Multi-tenancy
│   │   ├── flow-executor.ts       # Automation flows
│   │   ├── ddl-manager.ts          # Dynamic DDL (collections)
│   │   └── validation-engine.ts   # Field validation
│   ├── db/
│   │   ├── index.ts                # Kysely connection
│   │   ├── dynamic.ts              # Dynamic query builder
│   │   └── migrations/             # SQL migrations
│   ├── routes/
│   │   ├── auth.ts                 # Auth endpoints
│   │   ├── collections.ts          # Collection management
│   │   ├── data.ts                 # CRUD operations
│   │   ├── storage.ts              # File upload/download
│   │   ├── permissions.ts          # RBAC endpoints
│   │   ├── ai.ts                   # AI endpoints
│   │   └── ...                     # Many more routes
│   └── middleware/
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
| **Cache**         | ioredis     | Redis client for Valkey     |
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

- **Vanilla JS/TypeScript** - Plain JavaScript usage
- **Svelte 5** - Svelte stores and reactivity
- **React** - React hooks integration

#### Features

- Type-safe API client (Hono RPC)
- Real-time subscriptions
- Authentication helpers
- Offline support

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
      │                            │  (Casbin + God bypass)     │
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

### Authorization (Casbin + God Bypass)

**Casbin Policies:**

```csv
# p, subject, resource, action, scope
p, admin, *, *, ALL
p, manager, data, read, ORGANIZATION
p, employee, data, read, OWN
```

**God Bypass:**

Zveltio has a special **God bypass** that provides unlimited access regardless of Casbin policies:

```typescript
// In permissions.ts
const isGod = result.rows[0]?.role === 'god';
if (isGod) return true; // Bypass all Casbin checks
```

This allows creating a super-admin user with the CLI:

```bash
bun run packages/cli/src/index.ts create-god
```

---

## Technology Stack

### Core Technologies

| Category   | Technology  | Version | Purpose                       |
| ---------- | ----------- | ------- | ----------------------------- |
| Runtime    | Bun         | 1.2.0   | JavaScript/TypeScript runtime |
| Framework  | Hono        | 4.4.0   | Web framework                 |
| Database   | PostgreSQL  | 17      | Primary database              |
| ORM        | Kysely      | 0.27.6  | Query builder                 |
| Cache      | Valkey      | 8       | Redis-compatible cache        |
| Auth       | Better-Auth | 1.3.34  | Authentication                |
| RBAC       | Casbin      | 5.30.0  | Authorization                 |
| Storage    | SeaweedFS   | latest  | S3-compatible                 |
| UI         | SvelteKit   | 2.x     | Admin interface               |
| Validation | Zod         | 4.x     | Schema validation             |

### Infrastructure

| Service    | Image               | Ports      |
| ---------- | ------------------- | ---------- |
| PostgreSQL | pgvector/pg17       | 5432       |
| PgBouncer  | edoburu/pgbouncer   | 6432       |
| Valkey     | valkey/valkey:8     | 6379       |
| SeaweedFS  | chrislusf/seaweedfs | 8333, 8888 |
| Prometheus | prom/prometheus     | 9090       |
| Grafana    | grafana/grafana     | 3000       |

---

## Extensions System

Zveltio supports a plugin-based architecture through extensions:

```
extensions/
├── ai/                   # AI extensions
│   ├── core-ai/         # Chat, embeddings, search
│   └── ...
├── automation/          # Workflow automation
│   └── flows/          # Flow executor
├── compliance/         # Regional compliance
│   ├── ro/
│   │   ├── documents/  # Romanian documents
│   │   ├── efactura/  # eFactura
│   │   └── procurement/
│   └── ...
├── content/            # Content management
│   └── page-builder/
├── developer/          # Developer tools
│   └── edge-functions/
├── geospatial/        # Geographic data
│   └── postgis/
└── workflow/          # Workflow management
    ├── approvals/
    └── checklists/
```

Each extension follows the structure:

- `manifest.json` - Extension metadata
- `engine/` - Backend routes and logic
- `studio/` - Admin UI components
