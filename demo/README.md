# Live demo deployment

Everything needed to run `demo.zveltio.com` (or your own equivalent).

## What it gives visitors

- A pre-seeded Studio with **all five business templates installed**
  (CRM, Invoicing, Project Management, Help Desk, Asset Inventory).
- A throwaway admin user — credentials are surfaced on the login page and
  in a banner that's visible from every admin screen.
- A scheduled wipe (default: hourly) so the next visitor starts from the
  same baseline.

## Quick start (single host)

Prereqs: Docker + docker-compose, a domain pointing at the host, a reverse
proxy doing TLS. Caddy works well; nginx is fine.

```sh
# 1. Set secrets in .env (next to docker-compose.yml)
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
BETTER_AUTH_SECRET=$(openssl rand -hex 24)
PUBLIC_URL=https://demo.zveltio.com
EOF

# 2. Bring up the stack
docker compose -f demo/docker-compose.yml --env-file .env up -d

# 3. Seed the demo (admin user + all five templates)
BASE_URL=https://demo.zveltio.com bash demo/seed.sh

# 4. Wire the reset cron (hourly :00)
echo "0 * * * * cd /srv/zveltio && ZVELTIO_ENV=demo bash demo/reset.sh >>/var/log/zveltio-demo.log 2>&1" \
  | sudo tee /etc/cron.d/zveltio-demo-reset
```

That's it. The Studio is reachable on `https://demo.zveltio.com` and
every admin page shows the demo banner with the reset cadence.

## What `DEMO_MODE=true` changes

| Layer  | Effect                                                             |
| ------ | ------------------------------------------------------------------ |
| Engine | `/api/health` exposes `demo_mode: true` + credentials              |
| Engine | Middleware blocks user-deletion, API key creation, PITR restore, schedule creation, migrations, audit log wipe (451 Unavailable For Legal Reasons + `code: "DEMO_BLOCKED"`) |
| Studio | Yellow `DemoBanner` sticky on every admin page                     |
| Studio | Login page surfaces credentials + "Fill in" shortcut               |

Nothing else is gated. Visitors can build collections, install templates,
edit data, run queries — all the things you'd want them to try. The only
constraint is "they can't brick the demo for the next person."

## Why the reset wipes the DB instead of `pg_dump` + restore

A `pg_dump` based reset works fine when content is small, but the demo
collects extension installs over time (the marketplace adds rows in
`zv_extensions`). A full DB recreate guarantees identical state every
cycle. The trade-off is ~30s downtime per reset.

If you want zero-downtime, mount a fresh persistent volume per cycle and
swap them — but that's more infrastructure than a demo justifies.

## Cost on Hetzner CX22 (~€4/month)

The demo runs comfortably on a 2-vCPU / 4 GB / 40 GB VPS. RSS in steady
state is ~200 MB. Postgres + Valkey + engine together use about 1.5 GB
of memory; we leave headroom for Bun's GC.

## Updating the demo

```sh
docker compose -f demo/docker-compose.yml pull engine
docker compose -f demo/docker-compose.yml up -d engine
# Reset to apply any new migrations + re-seed
ZVELTIO_ENV=demo bash demo/reset.sh
```

If you want a "what's new" banner after each release, point the engine
at a specific tag instead of `:latest` so updates are explicit.

## Troubleshooting

- **Banner doesn't appear** — check `curl https://demo.zveltio.com/api/health`
  returns `"demo_mode":true`. The Studio relies entirely on that flag.
- **Reset cron fails silently** — check `/var/log/zveltio-demo.log`.
  Common failure: `ZVELTIO_ENV` not set on the cron line.
- **Login rejected** — the email/password in `.env` must match
  `DEMO_EMAIL`/`DEMO_PASSWORD` in `docker-compose.yml`. They're loaded by
  different processes.
