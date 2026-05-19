#!/usr/bin/env bash
# dr-drill.sh — Automate the parts of the DR drill that don't need a human.
#
# Runs the three scenarios that don't require Proxmox / external state:
#   1. Logical dump + restore round-trip
#   2. Smoke checks against the restored host (engine + DB + auth)
#   3. PITR rehearsal (if WAL archive is configured)
#
# Writes a markdown report with pass/fail + timings.
#
# Refuses to run unless ZVELTIO_ENV=drill — we do not want this executing
# against a production database by accident.

set -euo pipefail

if [[ "${ZVELTIO_ENV:-}" != "drill" ]]; then
  echo "✗ dr-drill.sh refuses to run unless ZVELTIO_ENV=drill" >&2
  echo "  This prevents accidental execution against production." >&2
  exit 2
fi

: "${DRILL_DB:?DRILL_DB must be set (target test DB name)}"
: "${DRILL_DB_USER:?DRILL_DB_USER must be set}"
: "${DRILL_BASE_URL:=http://localhost:3000}"
: "${DRILL_ADMIN_EMAIL:=admin@example.com}"
: "${DRILL_ADMIN_PASSWORD:?DRILL_ADMIN_PASSWORD must be set}"

TS=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
REPORT_DIR="docs/dr-drills"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/drill-$TS.md"

PASS_COUNT=0
FAIL_COUNT=0

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
pass() { echo "- ✓ $1 ($2 ms)" >>"$REPORT"; PASS_COUNT=$((PASS_COUNT + 1)); log "PASS  $1"; }
fail() { echo "- ✗ $1 — $2" >>"$REPORT"; FAIL_COUNT=$((FAIL_COUNT + 1)); log "FAIL  $1: $2"; }

cat >"$REPORT" <<EOF
# DR drill — $TS

- Host: \`$(hostname)\`
- Target DB: \`$DRILL_DB\`
- Engine URL: $DRILL_BASE_URL

## Results
EOF

# Helper: time a command in ms, store in $DURATION_MS
time_ms() {
  local t0 t1
  t0=$(date +%s%N)
  "$@"
  t1=$(date +%s%N)
  DURATION_MS=$(( (t1 - t0) / 1000000 ))
}

# ── 1. pg_dump + restore round-trip ─────────────────────────────────
DUMP_FILE=$(mktemp --suffix=.sql.gz)
SCRATCH_DB="${DRILL_DB}_scratch_$TS"

if time_ms pg_dump -U "$DRILL_DB_USER" -d "$DRILL_DB" | gzip >"$DUMP_FILE" 2>/dev/null; then
  pass "pg_dump completes" "$DURATION_MS"
  DUMP_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
  echo "  - dump size: $DUMP_SIZE bytes" >>"$REPORT"

  createdb -U "$DRILL_DB_USER" "$SCRATCH_DB" 2>/dev/null || true
  if time_ms bash -c "gunzip -c '$DUMP_FILE' | psql -U '$DRILL_DB_USER' -d '$SCRATCH_DB' >/dev/null 2>&1"; then
    pass "restore to scratch DB" "$DURATION_MS"
    ORIG_TABLES=$(psql -U "$DRILL_DB_USER" -d "$DRILL_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    REST_TABLES=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    if [[ "$ORIG_TABLES" == "$REST_TABLES" ]]; then
      pass "table count matches ($ORIG_TABLES tables)" 0
    else
      fail "table count differs" "orig=$ORIG_TABLES restored=$REST_TABLES"
    fi
  else
    fail "restore to scratch DB" "psql import failed"
  fi
  dropdb -U "$DRILL_DB_USER" "$SCRATCH_DB" 2>/dev/null || true
else
  fail "pg_dump completes" "command exited non-zero"
fi
rm -f "$DUMP_FILE"

# ── 2. Engine smoke check ───────────────────────────────────────────
if time_ms curl -sf -o /dev/null "$DRILL_BASE_URL/api/health"; then
  pass "engine /api/health responds" "$DURATION_MS"
else
  fail "engine /api/health responds" "curl failed"
fi

TOKEN=$(curl -sf -X POST "$DRILL_BASE_URL/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DRILL_ADMIN_EMAIL\",\"password\":\"$DRILL_ADMIN_PASSWORD\"}" \
  | grep -oE '"token":"[^"]+"' | cut -d'"' -f4 || echo "")

if [[ -n "$TOKEN" ]]; then
  pass "admin sign-in succeeds" 0
  if curl -sf -H "Authorization: Bearer $TOKEN" "$DRILL_BASE_URL/api/collections" >/dev/null; then
    pass "authenticated request succeeds" 0
  else
    fail "authenticated request" "GET /api/collections returned non-2xx"
  fi
else
  fail "admin sign-in" "no token in response"
fi

# ── 3. PITR rehearsal ───────────────────────────────────────────────
WAL_DIR="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
if [[ -d "$WAL_DIR" ]] && [[ -n "$(ls -A "$WAL_DIR" 2>/dev/null)" ]]; then
  WAL_COUNT=$(find "$WAL_DIR" -type f | wc -l | tr -d ' ')
  pass "WAL archive populated ($WAL_COUNT segments)" 0
  echo "  - PITR rehearsal: manual step — see DISASTER-RECOVERY.md § 4 Scenario C" >>"$REPORT"
else
  echo "- ⓘ WAL archive empty or missing at $WAL_DIR — PITR not configured (T2 setup skipped)" >>"$REPORT"
fi

# ── Summary ─────────────────────────────────────────────────────────
cat >>"$REPORT" <<EOF

## Summary

- Pass: $PASS_COUNT
- Fail: $FAIL_COUNT

EOF

echo ""
log "Report written to: $REPORT"
echo ""

if [[ $FAIL_COUNT -gt 0 ]]; then
  log "✗ Drill FAILED ($FAIL_COUNT scenarios)"
  exit 1
fi

log "✓ Drill passed ($PASS_COUNT scenarios)"
