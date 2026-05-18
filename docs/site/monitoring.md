# Monitoring

Prometheus and Grafana observability setup for Zveltio.

## Overview

Zveltio exposes metrics in Prometheus format and ships with pre-configured Grafana dashboards. Both are included in the default `docker-compose.yml` stack.

| Service | URL | Default credentials |
|---------|-----|---------------------|
| Prometheus | `http://localhost:9090` | None |
| Grafana | `http://localhost:3001` | `admin` / `admin` |
| Metrics endpoint | `http://localhost:3000/metrics` | Protected by `METRICS_TOKEN` if set |

> **Security:** Set `METRICS_TOKEN` in your `.env` to require `Authorization: Bearer <token>` on the `/metrics` endpoint. Without it, metrics are publicly accessible.

## Prometheus

Metrics are exposed at the `/metrics` endpoint on the engine:

```bash
# Access raw metrics
curl http://localhost:3000/metrics
```

Prometheus is pre-configured to scrape the engine via `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'zveltio'
    static_configs:
      - targets: ['engine:3000']
    scrape_interval: 15s
```

No additional configuration is needed when using the default Docker Compose stack — Prometheus will automatically start scraping on first boot.

## Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `zveltio_http_requests_total` | Counter | Total HTTP requests by method, path, status |
| `zveltio_http_request_duration_seconds` | Histogram | Request latency (p50, p95, p99) |
| `zveltio_db_query_duration_seconds` | Histogram | Database query duration by operation |
| `zveltio_cache_hits_total` | Counter | Valkey cache hit count |
| `zveltio_cache_misses_total` | Counter | Valkey cache miss count |
| `zveltio_webhooks_delivered_total` | Counter | Webhook deliveries by status |
| `zveltio_ai_tokens_used_total` | Counter | AI token consumption by provider |
| `zveltio_ddl_jobs_total` | Counter | DDL jobs by status (queued/completed/failed) |
| `zveltio_active_connections` | Gauge | Active database connections via PgDog |

## Grafana

Access Grafana at `http://localhost:3001` (credentials: `admin` / `admin` — change on first login).

### Pre-configured Dashboards

| Dashboard | Description |
|-----------|-------------|
| **Zveltio Overview** | System-wide health: request rate, latency, error rate, cache hit ratio |
| **AI Usage** | Token consumption by provider, cost estimates, request volume |
| **Webhooks** | Delivery success rate, retry queue depth, latency per endpoint |
| **Database** | Query duration percentiles, connection pool utilization, slow query log |

Dashboards are provisioned automatically from `grafana/dashboards/` — no manual import needed.

### Adding Custom Dashboards

Place a JSON dashboard file in `grafana/dashboards/` and restart Grafana:

```bash
docker compose restart grafana
```

## Slow Query Log

Zveltio automatically logs all requests exceeding the slow query threshold to the `zv_slow_queries` database table and to console (in development).

**Configuration:**
```env
SLOW_QUERY_THRESHOLD_MS=200   # default: 200ms
```

**View recent slow queries via API (admin only):**
```bash
curl -H "Cookie: ..." "http://localhost:3000/api/admin/slow-queries?limit=50&min_ms=500"
```

```json
{
  "slow_queries": [
    {
      "method": "GET",
      "path": "/api/data/orders",
      "query_params": { "filter": "{...}", "limit": "500" },
      "duration_ms": 1243,
      "status_code": 200,
      "created_at": "2026-01-01T12:00:00Z"
    }
  ]
}
```

**Query the database directly:**
```sql
-- Top 10 slowest paths (last 24h)
SELECT path, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms, COUNT(*) as hits
FROM zv_slow_queries
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY path
ORDER BY avg_ms DESC
LIMIT 10;
```

## EXPLAIN ANALYZE

For query plan inspection during development and staging, use the built-in explain endpoint (blocked in production):

```bash
curl -X POST http://localhost:3000/api/admin/explain \
  -H "Cookie: ..." \
  -H "Content-Type: application/json" \
  -d '{"collection": "orders", "sort": "created_at", "order": "desc", "limit": 20}'
```

Returns the full PostgreSQL query plan in JSON format.

## OpenTelemetry (Advanced)

For distributed tracing, Zveltio supports OpenTelemetry export. Configure the following environment variables:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318
OTEL_SERVICE_NAME=zveltio-engine
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Compatible with Jaeger, Tempo, Datadog, and any OTLP-compatible backend.

## Alerting

To set up alerts in Grafana, navigate to **Alerting → Alert Rules** and create rules based on Prometheus metrics. Recommended alerts:

- Error rate > 5% over 5 minutes
- p99 request latency > 2 seconds
- Database connection pool utilization > 80%
- DDL job failures (any)
- Disk space &lt; 20% on storage volume
