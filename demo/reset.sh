#!/usr/bin/env bash
# demo/reset.sh — wipe the demo DB + re-seed.
#
# Intended to run via cron on the demo host. Strategy:
#   1. Stop the engine container (so no half-written transactions linger).
#   2. Drop + recreate the `zveltio` database via psql on the postgres container.
#   3. Start the engine — it re-applies migrations on boot.
#   4. Call seed.sh to recreate the admin user + install templates.
#
# Designed to take < 60s end-to-end on a small VPS. The engine's
# DEMO_RESET_CRON env var should match whatever cron schedule calls this
# so the Studio banner shows accurate timing.
#
# Refuses to run unless ZVELTIO_ENV=demo so it can't be triggered by
# accident against a production install.

set -euo pipefail

if [[ "${ZVELTIO_ENV:-}" != "demo" ]]; then
  echo "✗ reset.sh refuses to run unless ZVELTIO_ENV=demo" >&2
  exit 2
fi

COMPOSE="${COMPOSE:-docker compose -f demo/docker-compose.yml}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

log "Stopping engine ..."
$COMPOSE stop engine

log "Dropping + recreating database ..."
$COMPOSE exec -T postgres psql -U zveltio -d postgres -c "DROP DATABASE IF EXISTS zveltio WITH (FORCE);"
$COMPOSE exec -T postgres psql -U zveltio -d postgres -c "CREATE DATABASE zveltio OWNER zveltio;"

log "Starting engine — it will run migrations on boot ..."
$COMPOSE up -d engine

log "Seeding demo content ..."
bash "$(dirname "$0")/seed.sh"

log "Reset complete."
