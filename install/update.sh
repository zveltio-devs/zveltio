#!/usr/bin/env bash
# =============================================================================
# Zveltio — Update Script
# =============================================================================
# Updates Zveltio engine to the latest (or specified) version.
# Preserves .env, database, and all data.
#
# Usage:
#   bash /opt/zveltio/update.sh
#   ZVELTIO_VERSION=v2.1.0 bash /opt/zveltio/update.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}${BLUE}==> $*${RESET}"; }

ZVELTIO_DIR="${ZVELTIO_DIR:-/opt/zveltio}"
ZVELTIO_VERSION="${ZVELTIO_VERSION:-latest}"

if [[ $EUID -ne 0 ]]; then
  error "Run as root: sudo bash ${ZVELTIO_DIR}/update.sh"
  exit 1
fi

header "Zveltio — Update"

# Resolve latest version
if [[ "$ZVELTIO_VERSION" == "latest" ]]; then
  info "Checking latest release..."
  ZVELTIO_VERSION=$(curl -fsSL https://api.github.com/repos/zveltio/zveltio/releases/latest \
    | grep '"tag_name"' | cut -d'"' -f4 || echo "main")
  info "Latest: ${ZVELTIO_VERSION}"
fi

# Read current version if tracked
CURRENT_VERSION="unknown"
if [[ -f "${ZVELTIO_DIR}/.version" ]]; then
  CURRENT_VERSION=$(cat "${ZVELTIO_DIR}/.version")
fi

if [[ "$CURRENT_VERSION" == "$ZVELTIO_VERSION" ]]; then
  success "Already on ${ZVELTIO_VERSION} — nothing to do."
  exit 0
fi

info "Updating ${CURRENT_VERSION} → ${ZVELTIO_VERSION}"

# Stop service
info "Stopping Zveltio..."
systemctl stop zveltio

# Backup current engine
BACKUP_DIR="${ZVELTIO_DIR}/backups/engine-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r "${ZVELTIO_DIR}/engine" "${BACKUP_DIR}/" 2>/dev/null || true
info "Engine backed up to ${BACKUP_DIR}"

# Download new version
BINARY_URL="https://github.com/zveltio/zveltio/releases/download/${ZVELTIO_VERSION}/zveltio-linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"

if [[ "$ZVELTIO_VERSION" != "main" ]] && curl -fsSL --head "$BINARY_URL" &>/dev/null; then
  info "Downloading binary ${ZVELTIO_VERSION}..."
  wget -q "$BINARY_URL" -O "${ZVELTIO_DIR}/zveltio.new"
  mv "${ZVELTIO_DIR}/zveltio.new" "${ZVELTIO_DIR}/zveltio"
  chmod +x "${ZVELTIO_DIR}/zveltio"
  success "Binary updated"
else
  info "Building from source..."
  BRANCH="${ZVELTIO_VERSION}"
  [[ "$BRANCH" == "main" ]] || BRANCH="$ZVELTIO_VERSION"

  git clone --depth=1 --branch "$BRANCH" \
    https://github.com/zveltio/zveltio.git /tmp/zveltio-update
  cd /tmp/zveltio-update
  BUN_MEMORY_LIMIT=2048 bun install --frozen-lockfile
  cd packages/engine && BUN_MEMORY_LIMIT=2048 bun run build:prod
  rm -rf "${ZVELTIO_DIR}/engine"
  mkdir -p "${ZVELTIO_DIR}/engine"
  cp -r dist/. "${ZVELTIO_DIR}/engine/"
  cp -r ../../extensions "${ZVELTIO_DIR}/" 2>/dev/null || true
  rm -rf /tmp/zveltio-update
  success "Engine built from source"
fi

# Fix permissions
chown -R zveltio:zveltio "${ZVELTIO_DIR}/engine" 2>/dev/null || \
  chown -R "${ZVELTIO_DIR##*/}:${ZVELTIO_DIR##*/}" "${ZVELTIO_DIR}/engine" 2>/dev/null || true

# Track version
echo "$ZVELTIO_VERSION" > "${ZVELTIO_DIR}/.version"

# Restart
systemctl start zveltio
sleep 2

if systemctl is-active --quiet zveltio; then
  success "Zveltio ${ZVELTIO_VERSION} is running"
else
  error "Zveltio failed to start after update. Check: journalctl -u zveltio -n 50"
  error "Rollback: cp -r ${BACKUP_DIR}/engine ${ZVELTIO_DIR}/ && systemctl start zveltio"
  exit 1
fi

header "Update complete: ${CURRENT_VERSION} → ${ZVELTIO_VERSION}"
echo -e "  Logs:     journalctl -u zveltio -f"
echo -e "  Backup:   ${BACKUP_DIR}"
echo ""
