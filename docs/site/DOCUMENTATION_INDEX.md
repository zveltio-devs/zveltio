# 📚 ZVELTIO DOCUMENTATION - MASTER INDEX

Complete guide to all documentation for Zveltio (Bun version).

---

## DOCUMENTATION OVERVIEW

**Total Documents:** 42
**Scope:** files in `docs/site/`. Add one, add it here.

> This index once had 12 of its 16 links broken: the files were renamed to
> lowercase and nothing checked. Nothing checks yet, so the discipline is
> manual — if you move or rename a doc, grep for its old name.

This index provides a complete map of Zveltio documentation.

---

## DOCUMENTATION BY COMPONENT

### 1. 🔥 **ZVELTIO ENGINE** (Backend API)

| Document                             | Purpose                         | Location |
| ------------------------------------ | ------------------------------- | -------- |
| [README.md](../../README.md)            | Getting started, features, APIs | Root     |
| [ARCHITECTURE.md](architecture.md)   | System architecture & tech stack | docs/   |
| [AUTHORIZATION.md](authorization.md) | Auth & RBAC + God bypass        | docs/    |
| [COLLECTIONS.md](collections.md)     | Dynamic collections system      | docs/    |
| [GHOST-DDL.md](GHOST-DDL.md)         | Zero-downtime DDL algorithm     | docs/    |
| [GRAPHQL.md](GRAPHQL.md)             | Auto-generated GraphQL API      | docs/    |

### 2. 🎨 **ZVELTIO STUDIO** (Admin UI)

| Document                           | Purpose                    | Location         |
| ---------------------------------- | -------------------------- | ---------------- |
| [EXTENSIONS.md](extensions.md)     | Plugin system & Studio UI  | docs/            |

### 3. 🛠️ **ZVELTIO CLI** (Command Line)

| Document     | Purpose           | Location                   |
| ------------ | ----------------- | -------------------------- |
| CLI Commands | Command reference | packages/cli/src/commands/ |

### 4. 📦 **@ZVELTIO/SDK** (JavaScript/TypeScript SDKs)

| Document  | Purpose                | Location                |
| --------- | ---------------------- | ----------------------- |
| SDK Types | TypeScript definitions | packages/sdk/src/types/ |

### 5. 🏗️ **INFRASTRUCTURE & OPERATIONS**

| Document                                     | Purpose                        | Location |
| -------------------------------------------- | ------------------------------ | -------- |
| [INSTALLATION.md](installation.md)           | Detailed setup instructions    | docs/    |
| [DEPLOYMENT.md](deployment.md)               | Production deployment (Docker) | docs/    |
| [MONITORING.md](monitoring.md)               | Prometheus & Grafana setup     | docs/    |
| [HORIZONTAL_SCALING.md](HORIZONTAL_SCALING.md) | HA & enterprise scaling      | docs/    |
| [SECURITY.md](security.md)                   | Security hardening             | docs/    |
| [TROUBLESHOOTING.md](troubleshooting.md)     | Common issues & solutions      | docs/    |
| [ECOSYSTEM.md](ECOSYSTEM.md)                 | Platform overview              | docs/    |

---

## DOCUMENTATION BY TOPIC

### Getting Started

- ✅ [Quick Start](../../README.md#-quick-start) - Fastest way to get running
- ✅ [Installation Guide](installation.md) - Detailed setup
- ✅ [Configuration](installation.md#step-4-configure-environment) - Environment setup
- ✅ [Alpha Track EOL](../private/ALPHA-TRACK-EOL.md) - Policy for the closed `1.0.0-alpha.*` line
- ✅ [Migration Alpha → Beta](MIGRATION-ALPHA-TO-BETA.md) - Upgrade path from alpha installs

### Core Concepts

- ✅ [Architecture](architecture.md) - System design, components, data flow
- ✅ [Authorization](authorization.md) - RBAC & God bypass
- ✅ [Collections](collections.md) - Dynamic schema-less tables
- ✅ [Ghost DDL](GHOST-DDL.md) - Zero-downtime migrations for 100k+ row tables
- ✅ [Ecosystem](ECOSYSTEM.md) - Platform overview

### Features

- ✅ [Extensions](extensions.md) - Plugin system (AI, Flows, Edge Functions, PostGIS, etc.)
- ✅ [GraphQL](GRAPHQL.md) - Auto-generated read-only GraphQL API
- ✅ [AI Integration](../../README.md#-ai-integration) - Universal AI providers + tool-calling

### Operations

- ✅ [Deployment](deployment.md) - Production deployment
- ✅ [Security](security.md) - Security hardening
- ✅ [Monitoring](monitoring.md) - Prometheus & Grafana
- ✅ [Horizontal Scaling](HORIZONTAL_SCALING.md) - HA & enterprise deployment
- ✅ [Troubleshooting](troubleshooting.md) - Common issues

---

## QUICK REFERENCE

### Installation

```bash
# Clone and setup
git clone https://github.com/your-org/zveltio.git
cd zveltio
bun install
docker compose up -d

# Initialize
bun run -T packages/engine/src/db/migrate.ts

# Create admin
bun run packages/cli/src/index.ts create-god

# Start
bun --watch packages/engine/src/index.ts
```

### Access Points

- **Engine API:** http://localhost:3000
- **Studio:** http://localhost:5173
- **Grafana:** http://localhost:3001

---

## LEARNING PATHS

### Path 1: Complete Beginner → Production

**Week 1: Setup & Basics**

1. Read [README.md](../../README.md)
2. Follow [Installation Guide](installation.md)
3. Learn [Architecture](architecture.md)

**Week 2: Build First App**

4. Configure [Authorization](authorization.md)
5. Understand [Collections](collections.md)
6. Set up [Extensions](extensions.md)

**Week 3: Deploy**

7. Follow [Deployment Guide](deployment.md)
8. Apply [Security Guide](security.md)
9. Set up [Monitoring](monitoring.md)

---

## DOCUMENTATION STRUCTURE

```
zveltio/
├── README.md                      # Positioning, features, quick start
├── AGENTS.md                      # Map of the repo for anyone (or anything)
│                                  #   about to change code. Start here.
├── CONTRIBUTING.md                # Dev setup, code rules, PR conventions
├── docs/
│   ├── MULTI-TENANCY.md          # How tenant isolation actually works
│   ├── AUDIT-COVERAGE.md         # What the gates do and do not cover
│   ├── adr/                      # Architecture decision records
│   ├── private/                  # Internal plans, handoffs, known gaps
│   │   ├── PROJECT-CONTEXT.md    #   What Zveltio is + the chronology
│   │   └── TECHNICAL-GAPS.md     #   What is knowingly unfinished
│   └── site/                     # Public documentation (this index lives here)
│       ├── architecture.md       #   System design, components, data flow
│       ├── installation.md       #   Setup guide
│       ├── CONFIGURATION.md      #   Every environment variable
│       ├── deployment.md         #   Production deployment
│       ├── security.md           #   Security hardening
│       └── …                     #   see the tables above for the rest
├── packages/
│   ├── engine/                   # API server
│   ├── cli/                      # Command line
│   ├── sdk/                      # Vanilla JS/TS client
│   ├── sdk-react/                # React 18+ hooks
│   ├── sdk-vue/                  # Vue 3 composables
│   ├── studio/                   # Admin UI
│   └── client/                   # Public-facing app
└── extensions/                   # First-party extensions (zveltio-extensions repo)
    ├── ai/
    ├── compliance/ro/
    ├── content/page-builder/
    ├── developer/edge-functions/
    ├── geospatial/postgis/
    └── workflow/{approvals,checklists}/
    # Note: flows, backup, insights, saved-queries, schema-branches,
    # tenants are all in engine core, not extensions.
```

---

## SUPPORT

- 📧 Email: support@zveltio.com
- 🐛 Issues: [GitHub Issues](https://github.com/zveltio-devs/zveltio/issues)

---

**Built with Bun ❤️ for Enterprises and Public Institutions**
