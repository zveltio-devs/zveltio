# 📊 Baseline Snapshot - Zveltio Before Optimizations

**Data capturii:** 2026-04-03  
**Scop:** Documentează starea exactă înainte de optimizări pentru debugging și rollback

---

## 🏗️ System Overview

### Versiuni Cheie:

- **Zveltio Engine:** 2.0.0
- **Bun:** 1.2.0
- **Node.js:** (via Bun)
- **OS:** Windows 11
- **Architecture:** x64

### Timp curent:

`2026-04-03 11:47:38 GMT+3`

---

## 📦 Dependencies Snapshot

### package.json Dependencies (zveltio/packages/engine/package.json):

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.600.0",
    "@aws-sdk/s3-request-presigner": "^3.600.0",
    "@hono/zod-validator": "^0.7.6",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.52.0",
    "@opentelemetry/sdk-node": "^0.52.0",
    "@better-auth/kysely-adapter": "1.5.3",
    "@types/pg": "^8.11.0",
    "better-auth": "1.5.3",
    "pg": "^8.11.0",
    "casbin": "^5.30.0",
    "dataloader": "^2.2.3",
    "expr-eval": "^2.0.2",
    "graphql": "^16.9.0",
    "graphql-yoga": "^5.10.4",
    "hono": "^4.4.0",
    "ioredis": "^5.3.2",
    "kysely": "^0.27.6",
    "nanoid": "^5.0.7",
    "pdfkit": "^0.15.0",
    "zod": "^4.3.6"
  }
}
```

### Total Dependencies Estimate:

- **~1800+ packages** (inclusiv transitive dependencies)
- **~8-13GB RAM** requirement estimat

---

## 📊 Memory Usage Metrics (Estimated)

### Startup Memory:

- **Initial:** ~500MB-1GB
- **After bootstrap:** ~2-3GB
- **Peak during operation:** ~8-13GB

### Key Memory Consumers:

1. **AWS SDK v3:** ~10MB+
2. **GraphQL Yoga:** ~5MB+
3. **PDFKit:** ~3MB+
4. **OpenTelemetry:** ~2MB+
5. **Dependencies transitive:** ~100MB+

---

## ⚡ Performance Benchmarks (Estimated)

### Startup Time:

- **Cold start:** 45-60 seconds
- **Warm start:** 20-30 seconds

### API Response Times:

- **Simple CRUD:** 50-100ms
- **Complex queries:** 200-500ms
- **File operations:** 500-2000ms

---

## 🏗️ Architecture Snapshot

### Module Structure:

```
zveltio/packages/engine/src/
├── index.ts              # Main entry point
├── db/                   # Database layer
├── routes/               # API routes
├── lib/                  # Core libraries
├── middleware/           # HTTP middleware
├── field-types/          # Field type system
├── workers/              # Background workers
└── tests/                # Test suite
```

### Heavy Import Locations:

- **src/routes/storage.ts**: AWS SDK imports
- **src/routes/media.ts**: AWS SDK imports
- **src/lib/graphql-dataloader.ts**: GraphQL imports
- **src/workers/pdf-worker.ts**: PDFKit imports
- **src/lib/telemetry.ts**: OpenTelemetry imports

---

## 🔧 Configuration Snapshot

### Environment Variables (typical):

```bash
PORT=3000
DATABASE_URL=postgresql://zveltio:zveltio@pooler:6432/zveltio
NATIVE_DATABASE_URL=postgresql://zveltio:zveltio@db:5432/zveltio
BETTER_AUTH_SECRET=changeme_in_production
VALKEY_URL=redis://:zveltio@cache:6379
S3_ENDPOINT=http://storage:8333
S3_ACCESS_KEY=changeme
S3_SECRET_KEY=changeme
S3_BUCKET=zveltio
```

### Docker Compose Services:

- PostgreSQL 17 + pgvector
- Valkey (Redis-compatible)
- SeaweedFS (S3 storage)
- PgDog (connection pooler)
- Prometheus + Grafana

---

## 📈 Build Metrics

### Bundle Size:

- **Engine only:** ~50-100MB
- **With all dependencies:** ~200-300MB

### Build Time:

- **First build:** 2-3 minutes
- **Incremental:** 30-60 seconds

---

## 🎯 Current Issues Identified

### Memory Problems:

1. **AWS SDK v3** - oversized pentru needs
2. **GraphQL** - încărcat dar mutat parțial în extensions
3. **PDFKit** - heavy, folosit doar în worker
4. **Multiple validators** - duplicate functionality

### Performance Bottlenecks:

1. **Startup time** - prea multe dependencies
2. **Memory growth** - gradual increase durante operation
3. **Dependency bloat** - 1800+ packages

---

## 🔍 Debugging Information

### Key Files for Rollback:

- `zveltio/packages/engine/package.json`
- `zveltio/packages/engine/src/index.ts`
- `zveltio/packages/engine/src/routes/storage.ts`
- `zveltio/packages/engine/src/routes/media.ts`
- `zveltio/packages/engine/src/lib/graphql-dataloader.ts`
- `zveltio/packages/engine/src/workers/pdf-worker.ts`

### Critical Dependencies to Monitor:

- `@aws-sdk/*` - memory hog
- `graphql`, `graphql-yoga` - partially used
- `pdfkit` - worker-only
- `dataloader` - GraphQL-related
- `expr-eval` - validation engine

---

## 📝 Pre-optimization Checks

### Sanity Checks:

- [ ] Engine starts successfully `bun run dev`
- [ ] All tests pass `bun test`
- [ ] Docker compose works `docker-compose up`
- [ ] Basic CRUD operations functional
- [ ] Authentication working
- [ ] File upload/download working

### Backup Recommended:

```bash
# Backup current state
git add .
git commit -m "Baseline before optimizations - 2026-04-03"
git tag baseline-pre-optimizations
```

---

## 🚀 Next Steps

1. **Implement Phase 1 optimizations** (AWS, GraphQL, PDFKit)
2. **Monitor memory usage** after each change
3. **Run tests** to ensure functionality
4. **Measure performance** improvements
5. **Document changes** in optimizari_cod_complete.md

---

**Status:** 🟡 Baseline captured - Ready for optimizations

_Acest fișier servește ca punct de restaurare și referință pentru toate optimizările viitoare._
