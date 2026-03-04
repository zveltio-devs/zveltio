# 🌍 Zveltio Ecosystem

**Complete overview of the Zveltio platform** - a modern, headless BaaS (Backend as a Service) solution built with Bun, designed for enterprises and public institutions.

---

## 📋 Table of Contents

- [What is Zveltio?](#what-is-zveltio)
- [Target Users](#target-users)
- [Key Features](#key-features)
- [Architecture Overview](#architecture-overview)
- [Packages](#packages)
- [Getting Started](#getting-started)
- [Use Cases](#use-cases)
- [Technology Choices](#technology-choices)

---

## What is Zveltio?

**Zveltio** is a complete **headless BaaS platform** built with Bun that provides:

- 🔧 **Dynamic Collections** - Create database tables without code
- 🔐 **Complete Auth & RBAC** - User management with granular permissions
- 🤖 **AI Integration** - Chat, semantic search, document intelligence
- 📊 **Universal Export** - Generate PDF, Excel, CSV from any data
- 🪝 **Webhooks** - Event-driven integrations
- 🌍 **i18n Support** - Built-in translation system
- 📈 **Analytics** - Usage tracking and insights
- 🎨 **Admin Interface** - No-code content management

### What makes Zveltio different?

Zveltio is built around three core principles:

**1. Bun Runtime.** Zveltio uses Bun as its JavaScript runtime, providing:

- Faster startup times
- Built-in package manager
- Native TypeScript support
- Superior performance

**2. Type-safety from database to browser.** The entire stack — from PostgreSQL queries through the Hono API layer to the SvelteKit frontend — shares a single TypeScript contract via Hono RPC.

**3. Data sovereignty by default.** Zveltio is self-hosted. Your data never leaves your infrastructure unless you explicitly choose a cloud AI provider.

---

## Target Users

### 🏢 **Enterprises**

**Use Cases:**

- Internal knowledge management
- Employee portals
- Document management systems
- Customer relationship management
- Project management
- Workflow automation

**Benefits:**

- Self-hosted for data sovereignty
- AI with privacy (Ollama)
- Granular permissions (RBAC)
- Audit trails
- Scalable architecture

### 🏛️ **Public Institutions**

**Use Cases:**

- Citizen portals
- Document request systems
- Internal management systems
- Public information databases
- Service request tracking
- Compliance management

**Benefits:**

- GDPR compliant
- Full data control
- Accessibility features
- Multi-language support
- Transparent audit logs

### 🚀 **Startups & SMBs**

**Use Cases:**

- Content management
- Internal tools
- Customer dashboards
- API backends
- Mobile app backends

**Benefits:**

- Rapid development
- Cost-effective (self-hosted)
- Scalable from day one
- Type-safe development
- Modern stack

---

## Key Features

### 🔧 **Dynamic Collections**

Create database tables through the admin interface without writing code:

```typescript
// Just use the Studio UI:
Collection: "products"
Fields:
  - name (text, required)
  - price (number, required)
  - description (richtext)
  - category (reference → categories)
  - images (files, multiple)
  - is_active (boolean, default: true)
```

Engine automatically:

- Creates PostgreSQL table
- Generates TypeScript types
- Exposes REST API
- Provides CRUD interface in Studio

### 🔐 **Advanced RBAC**

Scope-based permissions with Casbin + God bypass:

```javascript
// Permission scopes:
ALL; // Access to everything
ORGANIZATION; // Access within organization
DEPARTMENT; // Access within department
OWN; // Access to own records only

// Special: God bypass (role='god')
// Bypasses ALL Casbin checks - full access
```

### 🤖 **Universal AI Integration**

**Zero external dependencies** - support for any AI provider:

```typescript
// Supported out of the box:
✅ OpenAI (GPT-4, GPT-3.5)
✅ Anthropic (Claude 3)
✅ Ollama (Self-hosted)
✅ Azure OpenAI
✅ Any OpenAI-compatible API

// AI Features:
🤖 Context-aware chat
🔍 Semantic search (RAG)
📄 Document intelligence
📊 Data insights
🌐 AI translation
✨ Content generation
```

---

## Architecture Overview

```
                     ┌─────────────────────────────┐
                     │       End Users             │
                     │  (Public, Partners, Staff)  │
                     └──────────────┬──────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
               ↓                    ↓                    ↓
     ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
     │ Zveltio Studio   │ │ Zveltio Client   │ │  Mobile Apps     │
     │ (Admin Interface)│ │(Public Frontend) │ │  (via API)       │
     │  Port: 5173      │ │  Port: 5174      │ │                  │
     └─────────┬────────┘ └─────────┬────────┘ └─────────┬────────┘
               │                    │                    │
               └────────────────────┼────────────────────┘
                                    │ REST API + Hono RPC
                                    ↓
                     ┌──────────────────────────┐
                     │    Zveltio Engine        │
                     │    (API Gateway)         │
                     │    Port: 3000            │
                     │    Bun + Hono + Kysely    │
                     │                          │
                     │  • Dynamic Collections   │
                     │  • Better-Auth           │
                     │  • Casbin RBAC           │
                     │  • AI Services           │
                     │  • Webhooks              │
                     │  • Export Manager        │
                     └──────────────┬───────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
               ↓                    ↓                    ↓
     ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
     │   PostgreSQL     │ │     Valkey       │ │   SeaweedFS      │
     │   (Database)     │ │     (Cache)      │ │   (Storage)      │
     │   + pgvector     │ │   Port: 6379     │ │   Port: 8333     │
     │   via PgBouncer  │ │                  │ │   (S3 API)       │
     │   Port: 6432     │ │                  │ │                  │
     └──────────────────┘ └──────────────────┘ └──────────────────┘
```

**Key Characteristics:**

- ✅ **Distributed** - Components can run on different servers
- ✅ **Scalable** - Horizontal scaling at every layer
- ✅ **Type-Safe** - End-to-end TypeScript with Hono RPC
- ✅ **Modern** - Built with latest tech (Bun, Svelte 5, Hono, Kysely)
- ✅ **Secure** - Defense in depth security architecture

---

## Packages

Zveltio uses a monorepo structure with Turborepo:

### 1. **@zveltio/engine** 🔥 Core API

**Tech Stack:** Bun, Hono, Kysely, Better-Auth, Casbin

**Responsibilities:**

- REST API & Hono RPC endpoints
- Authentication & authorization
- Dynamic collection management
- AI service orchestration
- Webhook management
- File storage (S3)
- Export generation (PDF/Excel/CSV)

### 2. **@zveltio/studio** 🎨 Admin Interface

**Tech Stack:** SvelteKit 2, Svelte 5

**Responsibilities:**

- Admin dashboard
- Collection & field management
- User & permission management
- AI configuration
- Content editing
- Analytics & monitoring

### 3. **@zveltio/cli** 🛠️ Command Line

**Tech Stack:** Bun, Commander.js

**Commands:**

- `init` - Initialize new project
- `create-god` - Create super-admin user
- `migrate` - Database migrations
- `dev/build/start` - Development servers

### 4. **@zveltio/sdk** 📦 Client SDK

**Tech Stack:** TypeScript

**Supports:**

- Vanilla JS/TypeScript
- Svelte 5
- React

---

## Getting Started

### Prerequisites

- **Bun** >= 1.2.0
- **Docker** & **Docker Compose**
- **Git**

### Quick Setup

```bash
# 1. Clone repository
git clone https://github.com/your-org/zveltio.git
cd zveltio

# 2. Install dependencies
bun install

# 3. Start infrastructure
docker compose up -d

# 4. Initialize database
bun run -T packages/engine/src/db/migrate.ts

# 5. Create admin user
bun run packages/cli/src/index.ts create-god

# 6. Start development
bun --watch packages/engine/src/index.ts
```

### Access Points

- **Engine API:** http://localhost:3000
- **Studio (Admin):** http://localhost:5173

---

## Technology Choices

| Category      | Technology     | Version | Purpose            |
| ------------- | -------------- | ------- | ------------------ |
| Runtime       | Bun            | 1.2.0   | JavaScript runtime |
| Framework     | Hono           | 4.4.0   | Web framework      |
| Database      | PostgreSQL     | 17      | Primary database   |
| ORM           | Kysely         | 0.27.6  | Query builder      |
| Cache         | Valkey         | 8       | Redis-compatible   |
| Auth          | Better-Auth    | 1.3.34  | Authentication     |
| RBAC          | Casbin         | 5.30.0  | Authorization      |
| Storage       | SeaweedFS      | latest  | S3-compatible      |
| UI            | SvelteKit      | 2.x     | Admin interface    |
| Orchestration | Turborepo      | 2.0.0   | Monorepo           |
| Container     | Docker Compose | -       | Infrastructure     |

---

## Learn More

- [Installation Guide](docs/INSTALLATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Authorization](docs/AUTHORIZATION.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Extensions](docs/EXTENSIONS.md)
