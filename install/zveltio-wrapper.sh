#!/usr/bin/env bash
# /usr/local/bin/zveltio — system-wide wrapper around /opt/zveltio/zveltio.
#
# Loads ZVELTIO_DIR/.env into the current environment so commands like
# "sudo zveltio migrate" work from anywhere on the system without having to
# cd into /opt/zveltio first.
#
# Override the install dir with ZVELTIO_DIR=/path before invoking, e.g.:
#   ZVELTIO_DIR=/srv/zveltio zveltio status

set -euo pipefail

ZVELTIO_DIR="${ZVELTIO_DIR:-/opt/zveltio}"

if [[ ! -x "$ZVELTIO_DIR/zveltio" ]]; then
  echo "zveltio: binary not found at $ZVELTIO_DIR/zveltio" >&2
  echo "         set ZVELTIO_DIR=<install path> or run the installer." >&2
  exit 127
fi

# Source the .env file if it exists AND we can read it. The file is mode 600
# owned by the zveltio system user, so a non-root, non-zveltio caller can't
# read it — that's fine, "zveltio status" / "zveltio version" don't need DB
# env vars. Real DB-touching commands (migrate, create-god) need sudo.
if [[ -f "$ZVELTIO_DIR/.env" && -r "$ZVELTIO_DIR/.env" ]]; then
  set -a
  while IFS='=' read -r key val; do
    # Skip blanks and comments
    [[ -z "$key" || "$key" == \#* ]] && continue
    # Strip surrounding matching quotes from value
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < <(grep -vE '^\s*(#|$)' "$ZVELTIO_DIR/.env" 2>/dev/null)
  set +a
elif [[ -f "$ZVELTIO_DIR/.env" && "${1:-}" =~ ^(migrate|create-god|start)$ ]]; then
  # Soft warning — these commands genuinely need the env. Don't fail; the
  # binary itself will error with a clear message about DATABASE_URL.
  echo "zveltio: cannot read $ZVELTIO_DIR/.env (run with sudo)" >&2
fi

# pass-through to the real binary
exec "$ZVELTIO_DIR/zveltio" "$@"
