#!/usr/bin/env bash
# =============================================================================
# Zveltio — Uninstall Script
# =============================================================================
# Stops and removes Zveltio and all its services.
# Optionally deletes all data (PostgreSQL database, Valkey, SeaweedFS, .env).
#
# Usage:
#   bash /opt/zveltio/uninstall.sh            # keeps data
#   PURGE_DATA=yes bash /opt/zveltio/uninstall.sh  # removes everything
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
header()  { echo -e "\n${BOLD}${BLUE}==> $*${RESET}"; }

ZVELTIO_DIR="${ZVELTIO_DIR:-/opt/zveltio}"
PURGE_DATA="${PURGE_DATA:-no}"

if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}[ERROR]${RESET} Run as root: sudo bash ${ZVELTIO_DIR}/uninstall.sh"
  exit 1
fi

header "Zveltio — Uninstall"

# Confirm if interactive
if [[ -t 0 ]]; then
  echo ""
  if [[ "$PURGE_DATA" == "yes" ]]; then
    echo -e "${RED}${BOLD}WARNING: This will permanently delete all Zveltio data.${RESET}"
    echo -e "${RED}This includes the PostgreSQL database, all stored files, and configuration.${RESET}"
    echo ""
    read -r -p "Type 'DELETE ALL DATA' to confirm: " confirm
    if [[ "$confirm" != "DELETE ALL DATA" ]]; then
      echo "Aborted."
      exit 0
    fi
  else
    echo "This will remove Zveltio services but keep your data."
    echo "To also remove data, run: PURGE_DATA=yes bash $0"
    echo ""
    read -r -p "Continue? [y/N] " confirm
    if [[ "$confirm" != "y" ]] && [[ "$confirm" != "Y" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi
fi

# ── Stop and disable services ─────────────────────────────────────────────────
header "Stopping services"

for svc in zveltio seaweedfs valkey; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    systemctl stop "$svc"
    success "Stopped $svc"
  fi
  if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    systemctl disable "$svc"
    success "Disabled $svc"
  fi
  if [[ -f "/etc/systemd/system/${svc}.service" ]]; then
    rm -f "/etc/systemd/system/${svc}.service"
    success "Removed ${svc}.service"
  fi
done

systemctl daemon-reload

# ── Remove binaries ───────────────────────────────────────────────────────────
header "Removing binaries"

rm -f /usr/local/bin/weed
success "Removed SeaweedFS"

rm -f /usr/local/bin/valkey-server /usr/local/bin/valkey-cli
success "Removed Valkey"

# ── Remove Zveltio directory ──────────────────────────────────────────────────
if [[ "$PURGE_DATA" == "yes" ]]; then
  header "Purging all data"

  rm -rf "${ZVELTIO_DIR}"
  success "Removed ${ZVELTIO_DIR}"

  rm -rf /var/lib/seaweedfs
  rm -rf /etc/valkey /var/lib/valkey /var/log/valkey
  success "Removed SeaweedFS and Valkey data"

  # Drop PostgreSQL database and user
  if command -v psql &>/dev/null; then
    su -c "psql -c \"DROP DATABASE IF EXISTS zveltio;\"" postgres 2>/dev/null || true
    su -c "psql -c \"DROP USER IF EXISTS zveltio;\"" postgres 2>/dev/null || true
    rm -f /etc/postgresql/*/main/conf.d/zveltio.conf
    systemctl restart postgresql 2>/dev/null || true
    success "Dropped PostgreSQL database and user"
  fi

  # Remove system users
  userdel -r zveltio 2>/dev/null || userdel zveltio 2>/dev/null || true
  userdel valkey 2>/dev/null || true
  userdel seaweedfs 2>/dev/null || true
  success "Removed system users"

  # Remove firewall rule
  if command -v ufw &>/dev/null; then
    ufw delete allow 4000/tcp 2>/dev/null || true
  fi

else
  # Keep data, just remove application files
  rm -rf "${ZVELTIO_DIR}/engine"
  rm -f "${ZVELTIO_DIR}/zveltio"
  warn "Kept ${ZVELTIO_DIR}/.env and data. Remove manually if needed."
fi

header "Uninstall complete"
if [[ "$PURGE_DATA" != "yes" ]]; then
  echo -e "  Data preserved at: /var/lib/postgresql, /var/lib/seaweedfs, /var/lib/valkey"
  echo -e "  Config preserved:  ${ZVELTIO_DIR}/.env"
fi
echo ""
