#!/usr/bin/env bash
# fire-test.sh — bring up the whole Zveltio stack locally with EVERY extension
# enabled and demo data seeded, for a hands-on "test of fire" (WSL / Linux).
#
# What it does:
#   1. boots the engine from source against your Postgres, pointing EXTENSIONS_DIR
#      at the sibling zveltio-extensions checkout (auto-migrates on boot);
#   2. creates an admin (god) user;
#   3. enables all 54 extensions (scripts/enable-all-extensions.ts);
#   4. seeds the 5 business templates with sample data (scripts/seed-demo.ts);
#   5. leaves the engine running and prints how to open the Studio.
#
# The engine log streams to /tmp/zveltio-firetest.log. Ctrl-C stops the engine.
#
# Usage (from the zveltio/ repo root, inside WSL):
#   bash scripts/fire-test.sh
# Override anything via env, e.g.:
#   DATABASE_URL=postgresql://me:pw@localhost:5432/zv_fire bash scripts/fire-test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Config (override via env) ────────────────────────────────────────────────
: "${DATABASE_URL:=postgresql://rlstest:rlstest@localhost:5432/zveltio_firetest}"
: "${EXTENSIONS_DIR:=$REPO_ROOT/../zveltio-extensions}"
: "${PORT:=3000}"
: "${ADMIN_EMAIL:=admin@zveltio.com}"
: "${ADMIN_PASSWORD:=Test12345}"
export DATABASE_URL PORT
export EXTENSIONS_DIR
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-firetest-secret-32-chars-long-zzzzzz}"
export BETTER_AUTH_URL="http://localhost:${PORT}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-firetest-encryption-key-32-bytes-aaaaaaaa}"
export BASE_URL="http://127.0.0.1:${PORT}"
export TEST_EMAIL="$ADMIN_EMAIL"
export TEST_PASS="$ADMIN_PASSWORD"
export DEMO_ADMIN_EMAIL="$ADMIN_EMAIL"
export DEMO_ADMIN_PASSWORD="$ADMIN_PASSWORD"

if [[ ! -d "$EXTENSIONS_DIR" ]]; then
  echo "✗ EXTENSIONS_DIR not found: $EXTENSIONS_DIR" >&2
  echo "  Clone zveltio-extensions next to this repo, or set EXTENSIONS_DIR." >&2
  exit 1
fi

LOG=/tmp/zveltio-firetest.log
echo "▶ Booting engine on :$PORT (EXTENSIONS_DIR=$EXTENSIONS_DIR)…"
echo "  DB: $DATABASE_URL"
bun packages/engine/src/index.ts > "$LOG" 2>&1 &
ENGINE_PID=$!
trap 'echo; echo "▶ Stopping engine ($ENGINE_PID)…"; kill $ENGINE_PID 2>/dev/null || true' EXIT INT TERM

echo -n "  waiting for /api/health/ready "
for i in $(seq 1 90); do
  if curl -fsS "$BASE_URL/api/health/ready" >/dev/null 2>&1; then echo "✓"; break; fi
  echo -n "."
  sleep 1
  if [[ "$i" -eq 90 ]]; then
    echo " ✗"; echo "::error engine did not boot in 90s — last log lines:"; tail -40 "$LOG"; exit 1
  fi
done

echo "▶ Creating admin user ($ADMIN_EMAIL)…"
bun packages/engine/src/index.ts create-god \
  --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --name "Fire Test Admin" || true

echo "▶ Enabling all extensions…"
bun scripts/enable-all-extensions.ts || echo "  (some extensions may need Postgres extensions like postgis — see report above)"

echo "▶ Seeding demo templates…"
bun scripts/seed-demo.ts || echo "  (seed reported issues — see above)"

cat <<EOF

────────────────────────────────────────────────────────────────────────────
✅ Fire-test stack is up.

  Engine:   $BASE_URL           (log: $LOG)
  Admin:    $ADMIN_EMAIL / $ADMIN_PASSWORD

  Open the Studio in a second terminal:
      cd packages/studio && bun run dev
      → http://localhost:5173

  Try: /admin/templates (install), /admin/collections/erd (ERD),
       /admin/marketplace (extensions), /admin/tenants (members & roles).

Press Ctrl-C here to stop the engine.
────────────────────────────────────────────────────────────────────────────
EOF

# Keep the engine in the foreground so Ctrl-C stops it cleanly.
wait $ENGINE_PID
