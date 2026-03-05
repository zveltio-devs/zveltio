# 🚀 Zveltio Installation Guide

Step-by-step guide to install and configure Zveltio.

---

## Prerequisites

### Software Requirements

| Requirement        | Version   | Purpose                 |
| ------------------ | --------- | ----------------------- |
| **Bun**            | >= 1.2.0  | JavaScript runtime      |
| **Docker**         | >= 24.0.0 | Container platform      |
| **Docker Compose** | >= 2.20.0 | Container orchestration |
| **Git**            | >= 2.40.0 | Version control         |

### System Requirements

| Tier            | CPU      | RAM   | Disk       | Users     |
| --------------- | -------- | ----- | ---------- | --------- |
| **Minimum**     | 2 cores  | 4GB   | 50GB SSD   | &lt; 100  |
| **Recommended** | 4 cores  | 16GB  | 200GB SSD  | &lt; 1000 |
| **Enterprise**  | 8+ cores | 32GB+ | 500GB NVMe | 1000+     |

---

## Installation Steps

### Step 1: Clone Repository

```bash
git clone https://github.com/your-org/zveltio.git
cd zveltio
```

### Step 2: Install Dependencies

```bash
# Install all workspace dependencies
bun install
```

### Step 3: Start Infrastructure

```bash
# Start all services (PostgreSQL, Valkey, SeaweedFS, etc.)
docker compose up -d
```

**Services started:**

| Service    | Image               | Port       |
| ---------- | ------------------- | ---------- |
| PostgreSQL | pgvector/pg17       | 5432       |
| PgBouncer  | edoburu/pgbouncer   | 6432       |
| Valkey     | valkey/valkey:8     | 6379       |
| SeaweedFS  | chrislusf/seaweedfs | 8333, 8888 |
| Prometheus | prom/prometheus     | 9090       |
| Grafana    | grafana/grafana     | 3001       |

### Step 4: Configure Environment

```bash
# Copy example environment file
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Server
PORT=3000
NODE_ENV=development

# Database (via PgBouncer)
DATABASE_URL=postgresql://zveltio:zveltio@localhost:6432/zveltio

# Cache (Valkey)
REDIS_URL=redis://:zveltio@localhost:6379

# Authentication (⚠️ Change this in production!)
BETTER_AUTH_SECRET=change-me-in-production-min-32-chars
BETTER_AUTH_URL=http://localhost:3000

# Storage (SeaweedFS)
S3_ENDPOINT=http://localhost:8333
S3_REGION=us-east-1
S3_BUCKET=zveltio
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_PUBLIC_URL=http://localhost:8333
```

### Step 5: Initialize Database

```bash
# Run migrations
bun run -T packages/engine/src/db/migrate.ts
```

This creates all system tables:

- Better-Auth tables
- Collection metadata
- Permissions
- AI configurations
- Webhooks

### Step 6: Create Admin User

```bash
# Create God (super-admin) user
bun run packages/cli/src/index.ts create-god

# Interactive prompts:
# Email: admin@your-company.com
# Name: System Admin
# Password: *********
```

> ⚠️ This creates a user with `role='god'` which bypasses all permission checks.

### Step 7: Start Development Servers

```bash
# Terminal 1: Start Engine
bun --watch packages/engine/src/index.ts
# Engine runs at http://localhost:3000

# Terminal 2: Start Studio
cd packages/studio && bun run dev
# Studio runs at http://localhost:5173
```

---

## Verification

### Check Services

```bash
# Health check
curl http://localhost:3000/health
```

Expected response:

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

### Login to Studio

1. Open http://localhost:5173
2. Login with admin credentials created in Step 6

---

## Development Commands

```bash
# Install dependencies
bun install

# Start all services with turbo
bun run dev

# Start Engine only
bun --watch packages/engine/src/index.ts

# Start Studio only
cd packages/studio && bun run dev

# Run tests
bun run test

# Build for production
bun run build

# Build single binary
bun run build:binary
```

---

## Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL status
docker compose ps db

# Check logs
docker compose logs db

# Test connection manually
psql -h localhost -p 5432 -U zveltio -d zveltio
```

### Cache Connection Issues

```bash
# Check Valkey status
docker compose ps cache

# Test connection
docker compose exec cache valkey-cli -a zveltio PING
# Expected: PONG
```

### Cannot Create God User

1. Verify database is running and healthy
2. Check `.env` has correct `DATABASE_URL`
3. Run migrations: `bun run -T packages/engine/src/db/migrate.ts`

### Port Conflicts

If ports are already in use, modify `.env`:

```env
# Use different ports
PORT=3001
POSTGRES_PORT_HOST=5433
VALKEY_PORT_HOST=6380
```

---

## Next Steps

- [Configure AI Providers](AI.md)
- [Set up RBAC Policies](AUTHORIZATION.md)
- [Configure Webhooks](WEBHOOKS.md)
- [Deploy to Production](DEPLOYMENT.md)
