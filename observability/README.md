# Observability — Prometheus + Grafana

Drop-in stack for visualising Zveltio engine metrics. One command up.

## Run it

```sh
docker compose -f observability/docker-compose.yml up -d
```

- Prometheus UI: `http://localhost:9090`
- Grafana UI: `http://localhost:3001` (admin / admin — change on first login)
- Pre-provisioned dashboard: **Zveltio → Engine Overview**

Bring it down without losing dashboard edits:

```sh
docker compose -f observability/docker-compose.yml down
```

Bring it down and **wipe state**:

```sh
docker compose -f observability/docker-compose.yml down -v
```

## What's wired up

| Source | Metric prefix     | Notes                                         |
| ------ | ----------------- | --------------------------------------------- |
| Engine | `zveltio_*`       | `/api/metrics` — scraped every 15s            |
| Engine | `zveltio_zone_*`  | Per-zone request counters (intranet / client) |
| —      | `postgres_*`      | Optional: run `prom/postgres-exporter` alongside |

If `METRICS_TOKEN` is set on the engine, Prometheus needs the token in the
`Authorization` header. The easiest path is to expose `/api/metrics` only on
loopback/private interfaces and leave `METRICS_TOKEN` unset there.

## What the dashboard shows

- Uptime, active extensions
- Request rate (req/s, 1-min)
- Heap used vs heap total over time
- Heap usage %, RSS — thresholds at 70 % / 85 %
- Peak heap + peak RSS (leak-spotting)
- Per-zone request rate

Edit the JSON at `grafana/dashboards/zveltio-overview.json` and Grafana
re-loads it every 30 s. Export your changes back to that file before
committing.

## What it intentionally does NOT cover (yet)

- Per-route p95 latency — engine doesn't emit a histogram yet. Track in
  `docs/TECHNICAL-GAPS.md` § 1.3.
- Error rate by status code.
- DB query timing — requires the `pg_stat_statements` exporter.
- Realtime WS connection count (already collected via `/api/ws/info` but
  not yet exported).

PRs welcome.
