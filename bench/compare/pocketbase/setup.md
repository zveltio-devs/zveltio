# Pocketbase bench setup

One-time setup so the comparison is reproducible.

## 1. Start the comparison stack

```sh
docker compose -f bench/compare/pocketbase/docker-compose.yml up -d
```

This brings up Postgres (port 5433) for Zveltio and Pocketbase (port 8090).
Zveltio itself runs from the host — point it at `postgresql://zveltio:zveltio@localhost:5433/zveltio`.

## 2. Bootstrap Pocketbase admin

Open `http://localhost:8090/_/` and create the admin user. Defaults used by the bench:

- Email: `admin@example.com`
- Password: `admin12345678` (PB requires ≥10 chars)

## 3. Run the benches

```sh
# Zveltio side
BENCH_BASE_URL=http://localhost:3000 \
BENCH_TAG=zveltio \
bun run bench/runner.ts

# Pocketbase side
BENCH_BASE_URL=http://localhost:8090 \
BENCH_VARIANT=pocketbase \
BENCH_EMAIL=admin@example.com \
BENCH_PASSWORD=admin12345678 \
BENCH_TAG=pocketbase \
bun run bench/runner.ts
```

Results land in `bench/results/<tag>-<timestamp>.json`. See `bench/README.md`
for how to diff two runs.

## Notes

- Pocketbase uses SQLite by default; we don't try to make it use Postgres
  (different storage engines are part of what's being compared).
- The realtime bench is Zveltio-only — Pocketbase's SSE topology doesn't map
  cleanly onto our WS bench. Compare cold-start + REST CRUD + list pagination.
- Both engines run with default settings: no tuning. We're measuring
  out-of-the-box performance, which is what users actually feel.
