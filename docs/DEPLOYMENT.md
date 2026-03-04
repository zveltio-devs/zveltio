# 🚀 Zeltio Deployment Guide

Complete guide for deploying Zeltio to production.

---

## Table of Contents

- [Overview](#overview)
- [Production Requirements](#production-requirements)
- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)
- [SSL/TLS Setup](#ssltls-setup)
- [Monitoring](#monitoring)
- [Backup Strategies](#backup-strategies)
- [Scaling](#scaling)

---

## Overview

Zeltio can be deployed using Docker Compose for most use cases. For enterprise deployments, Kubernetes or other orchestration platforms can be used.

### Architecture

```
Internet
   ↓
Nginx (SSL Termination)
   ↓
┌─────────────────────────────────┐
│  Docker Compose Services:       │
│  • Engine (API)                 │
│  • Studio (Admin UI)            │
│  • PostgreSQL + PgBouncer       │
│  • Valkey (Cache)               │
│  • SeaweedFS (Storage)          │
└─────────────────────────────────┘
```

---

## Production Requirements

### Software

| Software       | Version   |
| -------------- | --------- |
| Docker         | >= 24.0.0 |
| Docker Compose | >= 2.20.0 |
| Git            | >= 2.40.0 |

### Hardware

| Tier           | CPU      | RAM   | Disk       | Network  |
| -------------- | -------- | ----- | ---------- | -------- |
| **Small**      | 2 cores  | 4GB   | 50GB SSD   | 100 Mbps |
| **Medium**     | 4 cores  | 16GB  | 200GB SSD  | 1 Gbps   |
| **Enterprise** | 8+ cores | 32GB+ | 500GB NVMe | 10 Gbps  |

---

## Docker Deployment

### Step 1: Clone and Configure

```bash
# Clone repository
git clone https://github.com/your-org/zeltio.git
cd zeltio

# Create production environment
cp .env.example .env.production
```

### Step 2: Configure Environment

Edit `.env.production`:

```env
# Server
PORT=3000
NODE_ENV=production

# Database (PostgreSQL via PgBouncer)
DATABASE_URL=postgresql://zeltio:PASSWORD@pooler:6432/zeltio_prod

# Cache (Valkey)
REDIS_URL=redis://:VALKEY_PASSWORD@cache:6379

# Authentication
BETTER_AUTH_SECRET=CHANGE_ME_64_RANDOM_CHARACTERS
BETTER_AUTH_URL=https://api.yourdomain.com

# Storage (S3)
S3_ENDPOINT=https://storage.yourdomain.com
S3_REGION=us-east-1
S3_BUCKET=zeltio-uploads
S3_ACCESS_KEY=YOUR_ACCESS_KEY
S3_SECRET_KEY=YOUR_SECRET_KEY
S3_PUBLIC_URL=https://storage.yourdomain.com

# CORS
CORS_ORIGINS=https://studio.yourdomain.com,https://app.yourdomain.com
```

### Step 3: Production Docker Compose

The included `docker-compose.yml` is production-ready. Key configurations:

- Health checks for all services
- Restart policies
- Network isolation
- Volume persistence

### Step 4: Start Services

```bash
# Start all services
docker compose up -d

# Check status
docker compose ps
```

### Step 5: Initialize Database

```bash
# Run migrations
docker compose exec engine bun run -T packages/engine/src/db/migrate.ts

# Create God user
docker compose exec engine bun run packages/cli/src/index.ts create-god
```

---

## SSL/TLS Setup

### Using Let's Encrypt (Recommended)

```bash
# Stop nginx temporarily
docker compose stop nginx

# Get certificates
docker run --rm \
  -v $(pwd)/certbot/conf:/etc/letsencrypt \
  -v $(pwd)/certbot/www:/var/www/certbot \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  --email admin@yourdomain.com \
  --agree-tos \
  -d api.yourdomain.com \
  -d studio.yourdomain.com

# Restart nginx
docker compose up -d nginx
```

### Auto-renewal

Add to crontab:

```bash
0 12 * * * docker run --rm \
  -v $(pwd)/certbot/conf:/etc/letsencrypt \
  -v $(pwd)/certbot/www:/var/www/certbot \
  certbot/certbot renew \
  && docker compose restart nginx
```

---

## Monitoring

### Prometheus

Metrics are available at `/metrics`:

```bash
curl http://localhost:3000/metrics
```

### Grafana

Access Grafana at http://localhost:3001 (default: admin/admin)

**Pre-configured dashboards:**

- Zeltio Overview
- AI Usage
- Webhooks

### Health Checks

```bash
# Check engine health
curl http://localhost:3000/health

# Check all services
docker compose ps
```

---

## Backup Strategies

### Database Backup

```bash
# Create backup script
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
docker compose exec -T db pg_dump -U zeltio zeltio_prod > backup_$DATE.sql

# Compress
gzip backup_$DATE.sql

# Upload to storage
aws s3 cp backup_$DATE.sql.gz s3://your-backup-bucket/
```

### Schedule Backups

```bash
# Daily at 2 AM
0 2 * * * /path/to/backup.sh
```

### Restore from Backup

```bash
# Stop services
docker compose stop engine

# Restore database
gunzip -c backup_20260304_020000.sql.gz | docker compose exec -T db psql -U zeltio zeltio_prod

# Start services
docker compose start engine
```

---

## Scaling

### Horizontal Scaling

For high availability, run multiple Engine instances:

```yaml
# docker-compose.override.yml
services:
  engine:
    deploy:
      replicas: 3
    depends_on:
      - pooler
      - cache
    environment:
      - DATABASE_URL=postgresql://zeltio:PASSWORD@pooler:6432/zeltio_prod
      - REDIS_URL=redis://:VALKEY_PASSWORD@cache:6379
```

### Load Balancing

Use Nginx or a load balancer to distribute traffic:

```nginx
upstream engine_backend {
    server engine:3000;
    server engine:3001;
    server engine:3002;
}

server {
    location / {
        proxy_pass http://engine_backend;
    }
}
```

---

## Security Hardening

### Firewall

```bash
# Allow only necessary ports
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw enable
```

### Secrets Management

Never commit secrets to Git:

```bash
# Use .env.production in .gitignore
echo ".env.production" >> .gitignore

# Use Docker secrets or external secret manager
# (AWS Secrets Manager, HashiCorp Vault, etc.)
```

### Regular Updates

```bash
# Pull latest changes
git pull origin main

# Rebuild images
docker compose build

# Restart services
docker compose up -d
```

---

## Troubleshooting

### Service Won't Start

```bash
# Check logs
docker compose logs engine

# Check resource usage
docker stats
```

### Database Connection Issues

```bash
# Verify PgBouncer connection
docker compose exec engine sh -c 'echo $DATABASE_URL'

# Test connection
docker compose exec db psql -U zeltio -d zeltio_prod -c "SELECT 1"
```

### Performance Issues

1. Check database query performance
2. Monitor Valkey cache hit rate
3. Review Prometheus metrics
4. Check disk I/O
