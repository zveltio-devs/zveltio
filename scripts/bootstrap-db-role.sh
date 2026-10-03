#!/usr/bin/env bash
#
# One-time database bootstrap, run as a superuser, so that the engine itself
# never has to be one.
#
# The engine connecting as `postgres` is the single reason tenant isolation can
# be bypassed: FORCE ROW LEVEL SECURITY does not bind a SUPERUSER or BYPASSRLS
# role, so every RLS policy in the schema is inert against it. This script
# performs the handful of operations that genuinely require superuser, once, up
# front — after which the engine runs as a plain role that RLS does bind.
#
# What actually needs superuser, and nothing else does:
#
#   * CREATE EXTENSION vector, postgis — neither is marked "trusted", so a
#     database owner cannot create them. pgcrypto and pg_trgm ARE trusted and
#     are created here only to keep the set in one place.
#   * CREATE ROLE — migrations 024 and 030 create zveltio_flow_reader and
#     zveltio_rls. Both migrations already skip creation when the role exists,
#     so pre-creating them here means the engine role does not need CREATEROLE
#     for them.
#
#   * CREATEROLE itself, on PostgreSQL 16 and later only. The engine gives each
#     extension a database role of its own (lib/extensions/ext-db-role.ts), a
#     member of zveltio_ext or zveltio_worker, so one extension's SQL cannot
#     reach another's tables even where the SQL analyzer is wrong. Making those
#     roles takes CREATEROLE plus ADMIN on the two parents. From 16 on CREATEROLE
#     reaches only roles the holder has ADMIN on — here zveltio_ext,
#     zveltio_worker and the roles it creates itself — and it cannot hand out
#     SUPERUSER, BYPASSRLS, REPLICATION or CREATEDB, nor membership in zveltio_rls
#     or any pg_* role. Below 16 CREATEROLE is close to superuser (it can grant
#     itself any non-superuser role, pg_read_all_data and pg_execute_server_program
#     included), so there the engine role stays NOCREATEROLE and every extension
#     shares zveltio_ext / zveltio_worker; the engine says so at boot.
#
# Migrations keep their `CREATE EXTENSION IF NOT EXISTS` lines and stay correct
# under the plain role: when the extension is already present the statement is
# a no-op and never reaches the privilege check.
#
#   * The BACKUP role, if you ask for one. `pg_dump` as the engine's own role
#     CANNOT dump this database — `FORCE ROW LEVEL SECURITY` binds the table
#     owner, and pg_dump refuses a table whose rows it cannot prove complete. It
#     fails on a freshly migrated database with no collections at all, because
#     `zv_edge_function_logs` ships with FORCE RLS. So the hardened install this
#     script builds is exactly the one whose backups do not work, unless a role
#     exists that row level security does not bind.
#
# Usage:
#   PGPASSWORD=... ./scripts/bootstrap-db-role.sh [DBNAME] [APPROLE] [APPPASS]
#
# Environment: PGHOST, PGPORT, PGUSER (the superuser) as usual.
#   ZVELTIO_BACKUP_PASSWORD  — set it and a `zveltio_backup` role is created,
#                              able to READ every row and change none. Leave it
#                              unset and the step is skipped with a warning, so
#                              nobody gets a privileged credential by accident.
#   ZVELTIO_BACKUP_ROLE      — name for it (default `zveltio_backup`).

set -euo pipefail

DB="${1:-${ZVELTIO_DB_NAME:-zveltio}}"
APP_ROLE="${2:-${ZVELTIO_DB_ROLE:-zveltio_app}}"
APP_PASS="${3:-${ZVELTIO_DB_PASSWORD:-}}"

if [ -z "$APP_PASS" ]; then
  echo "error: no password given for role '$APP_ROLE'." >&2
  echo "usage: $0 [DBNAME] [APPROLE] [APPPASS]   (or set ZVELTIO_DB_PASSWORD)" >&2
  exit 1
fi

# Passwords go into SQL string literals, so a quote in one ended the literal:
# `it's…` failed with `unrecognized role option "s"`. Double every quote.
sql_str() { printf '%s' "${1//\'/\'\'}"; }

SUPER_USER="${PGUSER:-postgres}"
psql_super() { psql -v ON_ERROR_STOP=1 -U "$SUPER_USER" "$@"; }

echo "→ database '$DB', engine role '$APP_ROLE'"

# CREATEROLE only where it is bounded by ADMIN (PostgreSQL 16+); see the header.
PG_VERSION_NUM="$(psql_super -d postgres -tAc 'SHOW server_version_num')"
if [ "$PG_VERSION_NUM" -ge 160000 ]; then
  CREATEROLE_ATTR=CREATEROLE
  EXT_PARENT_GRANT="WITH ADMIN TRUE, SET TRUE"
else
  CREATEROLE_ATTR=NOCREATEROLE
  EXT_PARENT_GRANT=""
fi

# ── The engine's own role ────────────────────────────────────────────────────
# NOSUPERUSER and NOBYPASSRLS are the entire point and are spelled out rather
# than left to defaults, so that reading this file tells you the guarantee.
# CREATEROLE on 16+, NOCREATEROLE below, for the reason in the header.
psql_super -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '$(sql_str "$APP_PASS")'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB $CREATEROLE_ATTR;
  ELSE
    ALTER ROLE $APP_ROLE LOGIN PASSWORD '$(sql_str "$APP_PASS")'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB $CREATEROLE_ATTR;
  END IF;
END
\$\$;
SQL
echo "  ✓ role $APP_ROLE (NOSUPERUSER, NOBYPASSRLS, $CREATEROLE_ATTR)"

# The roles the engine would otherwise have to create (migrations and boot).
psql_super -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
    CREATE ROLE zveltio_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_flow_reader') THEN
    CREATE ROLE zveltio_flow_reader NOLOGIN;
  END IF;
  -- The worker SQL bridge (lib/worker-extension-host.ts); migration 001 cannot
  -- create it without CREATEROLE, and the bridge then runs as zveltio_rls.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_worker') THEN
    CREATE ROLE zveltio_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- Inline extensions' ctx.db (lib/extensions/ext-db-role.ts); created at boot
  -- otherwise, which needs CREATEROLE.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_ext') THEN
    CREATE ROLE zveltio_ext NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;
SQL

# withTenantIsolation() does `SET LOCAL ROLE zveltio_rls`, which requires the
# engine role to be a member of it. Without this grant the engine starts in
# "unavailable" mode and — as of SEC-14 — refuses to serve production traffic.
psql_super -d postgres -q -c "GRANT zveltio_rls TO $APP_ROLE;"
psql_super -d postgres -q -c "GRANT zveltio_flow_reader TO $APP_ROLE;"
# ADMIN on the two extension parents (16+) lets the engine make each
# extension's role a member of them; SET TRUE spelled out because a re-run must
# repair a membership an earlier engine made for itself with SET FALSE.
psql_super -d postgres -q -c "GRANT zveltio_worker TO $APP_ROLE $EXT_PARENT_GRANT;"
psql_super -d postgres -q -c "GRANT zveltio_ext TO $APP_ROLE $EXT_PARENT_GRANT;"
echo "  ✓ zveltio_rls granted to $APP_ROLE"
if [ "$CREATEROLE_ATTR" = CREATEROLE ]; then
  echo "  ✓ zveltio_ext, zveltio_worker WITH ADMIN: one database role per extension"
else
  echo "  ! PostgreSQL < 16: extensions share one database role (see the header)"
fi

# ── Custom settings the engine stores ────────────────────────────────────────
# PostgreSQL 15+ treats a custom (placeholder) setting written into a function's
# SET clause or into ALTER DATABASE … SET/RESET as superuser-only unless SET on
# it was granted. The engine writes exactly two:
#   zveltio.current_tenant      migration 032's SECURITY DEFINER trigger
#                               function (SET clause) and 001's database default
#   zveltio.fail_closed_tenant  boot, ALTER DATABASE SET/RESET (ZVELTIO_FAIL_CLOSED_TENANT)
# Without these the first fails migration 032 ("permission denied to set
# parameter") and the install cannot migrate. Every other zveltio.* setting is
# set per transaction with set_config(), which needs no grant. Below 15 there is
# no such privilege and a placeholder is user-settable, so nothing is needed.
if [ "$PG_VERSION_NUM" -ge 150000 ]; then
  for param in zveltio.current_tenant zveltio.fail_closed_tenant; do
    psql_super -d postgres -q -c "GRANT SET ON PARAMETER $param TO $APP_ROLE;"
  done
  echo "  ✓ SET on zveltio.current_tenant, zveltio.fail_closed_tenant granted to $APP_ROLE"
fi

# ── The database, owned by the engine role ───────────────────────────────────
if ! psql_super -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
  psql_super -d postgres -q -c "CREATE DATABASE \"$DB\" OWNER $APP_ROLE;"
  echo "  ✓ database $DB created"
else
  psql_super -d postgres -q -c "ALTER DATABASE \"$DB\" OWNER TO $APP_ROLE;"
  echo "  ✓ database $DB exists, owner set"
fi

# Only the engine role may create temporary objects: PUBLIC holds TEMPORARY by
# default, and a restricted role's temp table would shadow engine tables on a
# pooled connection (docs/platform/multi-tenancy.md). The engine repeats this at
# boot; here it also covers a database the engine role will not own.
psql_super -d "$DB" -q -c "GRANT TEMPORARY ON DATABASE \"$DB\" TO $APP_ROLE;"
psql_super -d "$DB" -q -c "REVOKE TEMPORARY ON DATABASE \"$DB\" FROM PUBLIC;"
echo "  ✓ TEMPORARY on $DB: $APP_ROLE only"

# ── The extensions the engine cannot create for itself ───────────────────────
for ext in pgcrypto pg_trgm vector postgis; do
  if psql_super -d "$DB" -tAc \
      "SELECT 1 FROM pg_available_extensions WHERE name='$ext'" | grep -q 1; then
    psql_super -d "$DB" -q -c "CREATE EXTENSION IF NOT EXISTS $ext;"
    echo "  ✓ extension $ext"
  else
    # postgis is only needed by the geofencing surface, and vector only by
    # semantic search. An install without them should say so here rather than
    # fail three thousand lines into the first migration.
    echo "  ! extension $ext is not available on this server — skipped"
  fi
done

# The engine role owns the database but not the extension objects, which the
# superuser just created in the public schema.
psql_super -d "$DB" -q -c "GRANT USAGE ON SCHEMA public TO $APP_ROLE;"
psql_super -d "$DB" -q -c "GRANT CREATE ON SCHEMA public TO $APP_ROLE;"

# ── The backup role ──────────────────────────────────────────────────────────
#
# BYPASSRLS alone is not enough and the failure is confusing: the role is not the
# tables' owner and has no SELECT grant, so pg_dump gets `permission denied for
# table` instead of the RLS error, and it looks like a different problem.
# `pg_read_all_data` is the other half. Measured, both directions.
#
# Read-only by construction: `pg_read_all_data` grants SELECT and nothing else,
# and the role owns nothing. Verified — INSERT, UPDATE and DELETE all come back
# `permission denied for table`, DROP `must be owner`, CREATE `permission denied
# for schema public`.
BACKUP_ROLE="${ZVELTIO_BACKUP_ROLE:-zveltio_backup}"
BACKUP_PASS="${ZVELTIO_BACKUP_PASSWORD:-}"

if [ -n "$BACKUP_PASS" ]; then
  psql_super -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$BACKUP_ROLE') THEN
    CREATE ROLE $BACKUP_ROLE LOGIN PASSWORD '$(sql_str "$BACKUP_PASS")'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE $BACKUP_ROLE LOGIN PASSWORD '$(sql_str "$BACKUP_PASS")'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;
SQL
  psql_super -d "$DB" -q -c "GRANT CONNECT ON DATABASE \"$DB\" TO $BACKUP_ROLE;"
  psql_super -d "$DB" -q -c "GRANT pg_read_all_data TO $BACKUP_ROLE;"
  echo "  ✓ role $BACKUP_ROLE (BYPASSRLS + pg_read_all_data, read-only)"
else
  echo "  ! no ZVELTIO_BACKUP_PASSWORD — backup role NOT created."
  echo "    pg_dump as $APP_ROLE will FAIL on this database: FORCE ROW LEVEL"
  echo "    SECURITY binds the owner. Re-run with ZVELTIO_BACKUP_PASSWORD set,"
  echo "    or see docs/platform/disaster-recovery.md §3.1."
fi

echo
echo "Done. Point the engine at this role and it will be bound by RLS:"
echo "  DATABASE_URL=postgres://$APP_ROLE:<password>@${PGHOST:-localhost}:${PGPORT:-5432}/$DB"
if [ -n "$BACKUP_PASS" ]; then
  echo
  echo "Back up with the backup role, not the engine's:"
  echo "  BACKUP_DB_USER=$BACKUP_ROLE BACKUP_DB_PASSWORD=<password>   # engine route"
  echo "  PGUSER=$BACKUP_ROLE pg_dump -d $DB                          # cron"
fi
