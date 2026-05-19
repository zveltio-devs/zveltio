#!/usr/bin/env bash
# demo/seed.sh — bootstrap the demo with realistic content.
#
# Idempotent: re-running is safe — every step checks for "already exists"
# and continues. Designed to be called after `reset.sh` finishes wiping
# the database, or stand-alone on a fresh stack.
#
# Steps:
#   1. Create the demo admin user via better-auth sign-up.
#   2. Sign in and capture the session cookie.
#   3. Install every business template (CRM, Invoicing, etc.).
#
# Env:
#   BASE_URL       — engine base URL (default http://localhost:3000)
#   DEMO_EMAIL     — demo admin email (default demo@zveltio.com)
#   DEMO_PASSWORD  — demo admin password (default demo123456)

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DEMO_EMAIL="${DEMO_EMAIL:-demo@zveltio.com}"
DEMO_PASSWORD="${DEMO_PASSWORD:-demo123456}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

log "Waiting for engine at $BASE_URL ..."
for i in $(seq 1 60); do
  if curl -sf "$BASE_URL/api/health" > /dev/null 2>&1; then
    log "engine ready"
    break
  fi
  sleep 1
done

log "Creating demo admin user ..."
curl -sf -X POST "$BASE_URL/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\",\"name\":\"Demo Admin\"}" \
  > /dev/null 2>&1 || log "(user may already exist — continuing)"

log "Signing in ..."
SIGN_IN=$(curl -sf -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\"}")
echo "  → ok"

log "Installing built-in templates ..."
TEMPLATES=("crm" "invoicing" "project" "helpdesk" "inventory")
for tid in "${TEMPLATES[@]}"; do
  RES=$(curl -s -b "$COOKIE_JAR" -X POST "$BASE_URL/api/templates/$tid/install" \
    -H "Content-Type: application/json" -d '{"skip_existing":true}' || echo '{}')
  log "  - $tid → $(echo "$RES" | head -c 120)"
done

log "Done. Visit $BASE_URL — log in as $DEMO_EMAIL / $DEMO_PASSWORD"
