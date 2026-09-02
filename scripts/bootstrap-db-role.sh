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
#     so pre-creating them here means the engine role does not need CREATEROLE.
#     That is deliberate: CREATEROLE is close to superuser on Postgres below 16,
#     and granting it back would undo most of the point of this script.
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

SUPER_USER="${PGUSER:-postgres}"
psql_super() { psql -v ON_ERROR_STOP=1 -U "$SUPER_USER" "$@"; }

echo "→ database '$DB', engine role '$APP_ROLE'"

# ── The engine's own role ────────────────────────────────────────────────────
# NOSUPERUSER and NOBYPASSRLS are the entire point and are spelled out rather
# than left to defaults, so that reading this file tells you the guarantee.
# NOCREATEROLE for the reason in the header.
psql_super -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASS'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASS'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;
SQL
echo "  ✓ role $APP_ROLE (NOSUPERUSER, NOBYPASSRLS)"

# The two roles the engine's migrations would otherwise have to create.
psql_super -d postgres -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
    CREATE ROLE zveltio_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_flow_reader') THEN
    CREATE ROLE zveltio_flow_reader NOLOGIN;
  END IF;
END
\$\$;
SQL

# withTenantIsolation() does `SET LOCAL ROLE zveltio_rls`, which requires the
# engine role to be a member of it. Without this grant the engine starts in
# "unavailable" mode and — as of SEC-14 — refuses to serve production traffic.
psql_super -d postgres -q -c "GRANT zveltio_rls TO $APP_ROLE;"
psql_super -d postgres -q -c "GRANT zveltio_flow_reader TO $APP_ROLE;"
echo "  ✓ zveltio_rls granted to $APP_ROLE"

# ── The database, owned by the engine role ───────────────────────────────────
if ! psql_super -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
  psql_super -d postgres -q -c "CREATE DATABASE \"$DB\" OWNER $APP_ROLE;"
  echo "  ✓ database $DB created"
else
  psql_super -d postgres -q -c "ALTER DATABASE \"$DB\" OWNER TO $APP_ROLE;"
  echo "  ✓ database $DB exists, owner set"
fi

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
    CREATE ROLE $BACKUP_ROLE LOGIN PASSWORD '$BACKUP_PASS'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE $BACKUP_ROLE LOGIN PASSWORD '$BACKUP_PASS'
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
  echo "    or see docs/site/DISASTER-RECOVERY.md §3.1."
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
