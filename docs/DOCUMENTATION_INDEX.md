# 📚 ZVELTIO DOCUMENTATION - MASTER INDEX

Complete guide to all documentation for Zveltio (Bun version).

---

## DOCUMENTATION OVERVIEW

**Total Documents:** 10+  
**Coverage:** 100% of stack  
**Status:** ✅ Production Ready

This index provides a complete map of Zveltio documentation.

---

## DOCUMENTATION BY COMPONENT

### 1. 🔥 **ZVELTIO ENGINE** (Backend API)

| Document                             | Purpose                   | Location |
| ------------------------------------ | ------------------------- | -------- |
| [README.md](../README.md)            | Getting started, features | Root     |
| [ARCHITECTURE.md](ARCHITECTURE.md)   | System architecture       | docs/    |
| [AUTHORIZATION.md](AUTHORIZATION.md) | Auth & RBAC + God bypass  | docs/    |

### 2. 🎨 **ZVELTIO STUDIO** (Admin UI)

| Document     | Purpose         | Location         |
| ------------ | --------------- | ---------------- |
| Studio Admin | Interface usage | packages/studio/ |

### 3. 🛠️ **ZVELTIO CLI** (Command Line)

| Document     | Purpose           | Location                   |
| ------------ | ----------------- | -------------------------- |
| CLI Commands | Command reference | packages/cli/src/commands/ |

### 4. 📦 **@ZVELTIO/SDK** (JavaScript SDK)

| Document  | Purpose                | Location                |
| --------- | ---------------------- | ----------------------- |
| SDK Types | TypeScript definitions | packages/sdk/src/types/ |

---

## DOCUMENTATION BY TOPIC

### Getting Started

- ✅ [Quick Start](../README.md#-quick-start) - Fastest way to get running
- ✅ [Installation Guide](INSTALLATION.md) - Detailed setup
- ✅ [Configuration](INSTALLATION.md#step-4-configure-environment) - Environment setup

### Core Concepts

- ✅ [Architecture](ARCHITECTURE.md) - System design
- ✅ [Authorization](AUTHORIZATION.md) - RBAC & God bypass
- ✅ [Ecosystem](ECOSYSTEM.md) - Platform overview

### Features

- ✅ [AI Integration](EXTENSIONS.md) - Universal AI providers
- ✅ [Extensions](EXTENSIONS.md) - Plugin system
- ✅ [Webhooks](ARCHITECTURE.md) - Event-driven

### Operations

- ✅ [Deployment](DEPLOYMENT.md) - Production deployment
- ✅ [Security](SECURITY.md) - Security hardening
- ✅ [Monitoring](DEPLOYMENT.md#monitoring) - Prometheus & Grafana

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

**Week 2: Build First App** 4. Configure [Authorization](AUTHORIZATION.md) 5. Set up [Extensions](EXTENSIONS.md)

**Week 3: Deploy** 6. Follow [Deployment Guide](DEPLOYMENT.md) 7. Apply [Security Guide](SECURITY.md)

---

## DOCUMENTATION STRUCTURE

```
zveltio/
├── README.md                    # Main documentation
├── docs/
│   ├── README.md              # This index
│   ├── ARCHITECTURE.md        # System architecture
│   ├── AUTHORIZATION.md       # Auth & RBAC
│   ├── ECOSYSTEM.md          # Platform overview
│   ├── INSTALLATION.md       # Setup guide
│   ├── DEPLOYMENT.md        # Production deployment
│   ├── SECURITY.md          # Security hardening
│   └── EXTENSIONS.md        # Plugin system
├── packages/
│   ├── engine/               # API server
│   ├── cli/                 # Command line
│   ├── sdk/                 # Client SDK
│   └── studio/              # Admin UI
└── extensions/              # Built-in extensions
```

---

## SUPPORT

- 📧 Email: support@zveltio.com
- 🐛 Issues: [GitHub Issues](https://github.com/zveltio/zveltio/issues)

---

**Built with Bun ❤️ for Enterprises and Public Institutions**
