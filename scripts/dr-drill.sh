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

# The pipeline goes INSIDE time_ms, with pipefail, for two reasons that both
# stopped this script from ever running. `time_ms pg_dump … | gzip` puts the
# left side of the pipe in a subshell, so `DURATION_MS` was assigned somewhere
# the parent could not see and `set -u` aborted on the next line. And the `if`
# was testing gzip's exit status, so a pg_dump that failed halfway would have
# been reported as a passing backup — which is the single worst thing a drill
# can get wrong.
if time_ms bash -c "set -o pipefail; pg_dump -U '$DRILL_DB_USER' -d '$DRILL_DB' | gzip > '$DUMP_FILE'"; then
  pass "pg_dump completes" "$DURATION_MS"
  DUMP_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
  echo "  - dump size: $DUMP_SIZE bytes" >>"$REPORT"

  createdb -U "$DRILL_DB_USER" "$SCRATCH_DB" 2>/dev/null || true
  if time_ms bash -c "set -o pipefail; gunzip -c '$DUMP_FILE' | psql -v ON_ERROR_STOP=1 -U '$DRILL_DB_USER' -d '$SCRATCH_DB' >/dev/null"; then
    pass "restore to scratch DB" "$DURATION_MS"

    # What follows is the drill. Everything above only proves two commands
    # exited zero.
    #
    # The original check compared TABLE COUNTS, which a restore passes while
    # being useless: every table present and every one of them empty is the
    # commonest way a backup disappoints, and it scores full marks here. So the
    # comparisons below are about content and about the things an operator would
    # only discover the day they need them.
    ORIG_TABLES=$(psql -U "$DRILL_DB_USER" -d "$DRILL_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    REST_TABLES=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    if [[ "$ORIG_TABLES" == "$REST_TABLES" ]]; then
      pass "table count matches ($ORIG_TABLES tables)" 0
    else
      fail "table count differs" "orig=$ORIG_TABLES restored=$REST_TABLES"
    fi

    # Rows, table by table, for everything that holds data. A dump that
    # restored the schema and lost the contents is the failure this exists for.
    ROW_SQL="SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (
               SELECT c.relname AS t, c.reltuples::bigint AS n
                 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                WHERE ns.nspname = 'public' AND c.relkind = 'r') s"
    psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -qc "ANALYZE" >/dev/null 2>&1 || true
    psql -U "$DRILL_DB_USER" -d "$DRILL_DB" -qc "ANALYZE" >/dev/null 2>&1 || true
    ORIG_ROWS=$(psql -U "$DRILL_DB_USER" -d "$DRILL_DB" -tAc "$ROW_SQL")
    REST_ROWS=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "$ROW_SQL")
    if [[ "$ORIG_ROWS" == "$REST_ROWS" ]]; then
      pass "row counts match across every table" 0
    else
      fail "row counts differ" "the restore has different contents — see the report"
      echo "  - original: $ORIG_ROWS" >>"$REPORT"
      echo "  - restored: $REST_ROWS" >>"$REPORT"
    fi

    # Tenant isolation is policies plus a role, and only one of them is in the
    # dump. Losing the policies would put every tenant's rows in reach of every
    # other one, on the day the instance is already having its worst day.
    ORIG_POL=$(psql -U "$DRILL_DB_USER" -d "$DRILL_DB" -tAc "SELECT count(*) FROM pg_policy")
    REST_POL=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM pg_policy")
    if [[ "$ORIG_POL" == "$REST_POL" ]] && [[ "$ORIG_POL" != "0" ]]; then
      pass "RLS policies restored ($ORIG_POL policies)" 0
    else
      fail "RLS policies not restored" "orig=$ORIG_POL restored=$REST_POL"
    fi

    ORIG_FORCED=$(psql -U "$DRILL_DB_USER" -d "$DRILL_DB" -tAc "SELECT count(*) FROM pg_class WHERE relforcerowsecurity")
    REST_FORCED=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM pg_class WHERE relforcerowsecurity")
    if [[ "$ORIG_FORCED" == "$REST_FORCED" ]]; then
      pass "FORCE ROW LEVEL SECURITY survives ($ORIG_FORCED tables)" 0
    else
      fail "FORCE ROW LEVEL SECURITY lost" "orig=$ORIG_FORCED restored=$REST_FORCED"
    fi

    # `zveltio_rls` is a CLUSTER object. `pg_dump` does not carry roles, so a
    # restore onto a fresh server has the policies and not the role they depend
    # on. Here it passes because the drill restores into the same cluster; the
    # report says so, because the operator restoring onto new hardware is the
    # one who needs to know.
    if psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "SELECT 1 FROM pg_roles WHERE rolname='zveltio_rls'" | grep -q 1; then
      pass "zveltio_rls role reachable from the restore" 0
      echo "  - NOTE: roles live in the cluster, not the dump. Restoring onto a NEW" >>"$REPORT"
      echo "    server also needs \`pg_dumpall --roles-only\`, or migration 030 re-run," >>"$REPORT"
      echo "    or tenant isolation has policies with no role to enforce them." >>"$REPORT"
    else
      fail "zveltio_rls role missing in the restored cluster" "policies cannot be enforced"
    fi
    # The question none of the counting answers: is the restore USABLE?
    #
    # Everything above compares two databases. This reads the restored one the
    # way the engine reads it — as `zveltio_rls`, inside a transaction carrying
    # a tenant in the GUC — so it exercises the policy, the role and the data
    # together. A restore where any one of those three is wrong looks perfect to
    # a table count and returns nothing here.
    #
    # `contacts` because it is a core collection present on every install, and
    # the assertion is that the tenant sees exactly its own rows: a zero would
    # mean the policy denies everything, and a number larger than the tenant's
    # would mean it is not filtering at all. Both are disasters, in opposite
    # directions, and both pass a count of tables.
    # Resolve the tenant BEFORE dropping into the role, and pass it as a
    # literal.
    #
    # The first version of this let the isolation query pick its own tenant with
    # `(SELECT tenant_id FROM zvd_contacts LIMIT 1)` — inside the transaction,
    # after `SET LOCAL ROLE`. That subquery is itself subject to RLS, and with
    # no tenant set yet the policy falls back to the default one, so on any
    # instance whose contacts belong to some other tenant it selected nothing,
    # set the GUC to NULL, and reported a total failure of isolation where there
    # was none. It passed locally, where the data happened to sit in the default
    # tenant, and failed the first time CI ran it against a database seeded
    # differently. A check that depends on which tenant owns the sample data is
    # not a check.
    DRILL_TENANT=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc \
      "SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1" 2>/dev/null | tr -d ' ')

    if [[ -z "$DRILL_TENANT" ]]; then
      fail "restored data readable under tenant isolation" "no tenant in zv_tenants to read as"
    else
      # One row for a real tenant and one for a tenant that does not exist, so a
      # wrong answer is available in both directions: a restore that denies
      # everything returns 0, and one that lost its filtering returns 2. Written
      # as superuser, which RLS does not apply to, into a database that is
      # dropped a few lines below.
      psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -qc \
        "INSERT INTO zvd_contacts (first_name, last_name, tenant_id)
         VALUES ('drill', 'own-tenant', '$DRILL_TENANT'),
                ('drill', 'other-tenant', gen_random_uuid())" >/dev/null 2>&1 || true

      ISO_SQL="BEGIN;
        SET LOCAL ROLE zveltio_rls;
        SELECT set_config('zveltio.current_tenant', '$DRILL_TENANT', true);
        SELECT 'VISIBLE=' || count(*) FROM zvd_contacts;
        COMMIT;"
      RESTORED_VISIBLE=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc "$ISO_SQL" 2>/dev/null | sed -n 's/^VISIBLE=//p')
      EXPECTED_VISIBLE=$(psql -U "$DRILL_DB_USER" -d "$SCRATCH_DB" -tAc \
        "SELECT count(*) FROM zvd_contacts WHERE tenant_id::text = '$DRILL_TENANT'" 2>/dev/null | tr -d ' ')

      if [[ -n "$RESTORED_VISIBLE" ]] && [[ "$RESTORED_VISIBLE" == "$EXPECTED_VISIBLE" ]]; then
        pass "restored data readable under tenant isolation ($RESTORED_VISIBLE of its own rows)" 0
      else
        fail "restored data not readable under tenant isolation" \
          "as zveltio_rls the tenant sees '$RESTORED_VISIBLE', expected '$EXPECTED_VISIBLE'"
      fi
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

# A cookie, not a bearer token.
#
# Sign-in returns a `token` field and this used to send it as
# `Authorization: Bearer`, which the engine answers 401 to — better-auth's
# bearer plugin is not enabled, so sessions are cookies and always have been.
# The check could never have passed; nobody found out because the script aborted
# further up before ever reaching it.
COOKIE_JAR=$(mktemp)
if curl -sf -c "$COOKIE_JAR" -X POST "$DRILL_BASE_URL/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DRILL_ADMIN_EMAIL\",\"password\":\"$DRILL_ADMIN_PASSWORD\"}" >/dev/null; then
  pass "admin sign-in succeeds" 0
  if curl -sf -b "$COOKIE_JAR" "$DRILL_BASE_URL/api/collections" >/dev/null; then
    pass "authenticated request succeeds" 0
  else
    fail "authenticated request" "GET /api/collections returned non-2xx"
  fi
else
  fail "admin sign-in" "sign-in returned non-2xx"
fi
rm -f "$COOKIE_JAR"

# ── 3. PITR rehearsal ───────────────────────────────────────────────
WAL_DIR="${WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
if [[ -d "$WAL_DIR" ]] && [[ -n "$(ls -A "$WAL_DIR" 2>/dev/null)" ]]; then
  WAL_COUNT=$(find "$WAL_DIR" -type f | wc -l | tr -d ' ')
  pass "WAL archive populated ($WAL_COUNT segments)" 0
  echo "  - PITR rehearsal: manual step — see disaster-recovery.md § 4 Scenario C" >>"$REPORT"
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
