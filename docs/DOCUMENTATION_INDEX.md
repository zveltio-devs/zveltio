# 📚 ZVELTIO DOCUMENTATION - MASTER INDEX

Complete guide to all documentation for Zveltio (Bun version).

---

## DOCUMENTATION OVERVIEW

**Total Documents:** 15
**Coverage:** 100% of stack
**Status:** ✅ Production Ready

This index provides a complete map of Zveltio documentation.

---

## DOCUMENTATION BY COMPONENT

### 1. 🔥 **ZVELTIO ENGINE** (Backend API)

| Document                             | Purpose                         | Location |
| ------------------------------------ | ------------------------------- | -------- |
| [README.md](../README.md)            | Getting started, features, APIs | Root     |
| [ARCHITECTURE.md](ARCHITECTURE.md)   | System architecture & tech stack | docs/   |
| [AUTHORIZATION.md](AUTHORIZATION.md) | Auth & RBAC + God bypass        | docs/    |
| [COLLECTIONS.md](COLLECTIONS.md)     | Dynamic collections system      | docs/    |
| [GHOST-DDL.md](GHOST-DDL.md)         | Zero-downtime DDL algorithm     | docs/    |
| [GRAPHQL.md](GRAPHQL.md)             | Auto-generated GraphQL API      | docs/    |

### 2. 🎨 **ZVELTIO STUDIO** (Admin UI)

| Document                           | Purpose                    | Location         |
| ---------------------------------- | -------------------------- | ---------------- |
| [EXTENSIONS.md](EXTENSIONS.md)     | Plugin system & Studio UI  | docs/            |

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
| [INSTALLATION.md](INSTALLATION.md)           | Detailed setup instructions    | docs/    |
| [DEPLOYMENT.md](DEPLOYMENT.md)               | Production deployment (Docker) | docs/    |
| [MONITORING.md](MONITORING.md)               | Prometheus & Grafana setup     | docs/    |
| [HORIZONTAL_SCALING.md](HORIZONTAL_SCALING.md) | HA & enterprise scaling      | docs/    |
| [SECURITY.md](SECURITY.md)                   | Security hardening             | docs/    |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md)     | Common issues & solutions      | docs/    |
| [ECOSYSTEM.md](ECOSYSTEM.md)                 | Platform overview              | docs/    |

---

## DOCUMENTATION BY TOPIC

### Getting Started

- ✅ [Quick Start](../README.md#-quick-start) - Fastest way to get running
- ✅ [Installation Guide](INSTALLATION.md) - Detailed setup
- ✅ [Configuration](INSTALLATION.md#step-4-configure-environment) - Environment setup

### Core Concepts

- ✅ [Architecture](ARCHITECTURE.md) - System design, components, data flow
- ✅ [Authorization](AUTHORIZATION.md) - RBAC & God bypass
- ✅ [Collections](COLLECTIONS.md) - Dynamic schema-less tables
- ✅ [Ghost DDL](GHOST-DDL.md) - Zero-downtime migrations for 100k+ row tables
- ✅ [Ecosystem](ECOSYSTEM.md) - Platform overview

### Features

- ✅ [Extensions](EXTENSIONS.md) - Plugin system (AI, Flows, Edge Functions, PostGIS, etc.)
- ✅ [GraphQL](GRAPHQL.md) - Auto-generated read-only GraphQL API
- ✅ [AI Integration](../README.md#-ai-integration) - Universal AI providers + tool-calling

### Operations

- ✅ [Deployment](DEPLOYMENT.md) - Production deployment
- ✅ [Security](SECURITY.md) - Security hardening
- ✅ [Monitoring](MONITORING.md) - Prometheus & Grafana
- ✅ [Horizontal Scaling](HORIZONTAL_SCALING.md) - HA & enterprise deployment
- ✅ [Troubleshooting](TROUBLESHOOTING.md) - Common issues

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

1. Read [README.md](../README.md)
2. Follow [Installation Guide](INSTALLATION.md)
3. Learn [Architecture](ARCHITECTURE.md)

**Week 2: Build First App**

4. Configure [Authorization](AUTHORIZATION.md)
5. Understand [Collections](COLLECTIONS.md)
6. Set up [Extensions](EXTENSIONS.md)

**Week 3: Deploy**

7. Follow [Deployment Guide](DEPLOYMENT.md)
8. Apply [Security Guide](SECURITY.md)
9. Set up [Monitoring](MONITORING.md)

---

## DOCUMENTATION STRUCTURE

```
zveltio/
├── README.md                      # Main documentation
├── docs/
│   ├── DOCUMENTATION_INDEX.md    # This index
│   ├── ARCHITECTURE.md           # System architecture
│   ├── AUTHORIZATION.md          # Auth & RBAC
│   ├── COLLECTIONS.md            # Dynamic collections
│   ├── ECOSYSTEM.md              # Platform overview
│   ├── EXTENSIONS.md             # Plugin system
│   ├── GHOST-DDL.md              # Zero-downtime DDL
│   ├── GRAPHQL.md                # GraphQL API
│   ├── HORIZONTAL_SCALING.md     # HA & scaling
│   ├── INSTALLATION.md           # Setup guide
│   ├── DEPLOYMENT.md             # Production deployment
│   ├── MONITORING.md             # Prometheus & Grafana
│   ├── SECURITY.md               # Security hardening
│   └── TROUBLESHOOTING.md        # Common issues
├── packages/
│   ├── engine/                   # API server
│   ├── cli/                      # Command line
│   ├── sdk/                      # Vanilla JS/TS client
│   ├── sdk-react/                # React 18+ hooks
│   ├── sdk-vue/                  # Vue 3 composables
│   ├── studio/                   # Admin UI
│   └── client/                   # Public-facing app
└── extensions/                   # Built-in extensions
    ├── ai/core-ai/
    ├── automation/flows/
    ├── compliance/ro/
    ├── content/page-builder/
    ├── developer/edge-functions/
    ├── geospatial/postgis/
    └── workflow/{approvals,checklists}/
```

---

## SUPPORT

- 📧 Email: support@zveltio.com
- 🐛 Issues: [GitHub Issues](https://github.com/zveltio/zveltio/issues)

---

**Built with Bun ❤️ for Enterprises and Public Institutions**
