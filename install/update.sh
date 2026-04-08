#!/usr/bin/env bash
# =============================================================================
# Zveltio — Update Script
# =============================================================================
# Updates Zveltio to the latest (or specified) version.
# Auto-detects install mode: Docker or native.
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

# ── Resolve target version ────────────────────────────────────────────────────
if [[ "$ZVELTIO_VERSION" == "latest" ]]; then
  info "Checking latest release..."
  ZVELTIO_VERSION=$(curl -fsSL https://api.github.com/repos/zveltio/zveltio/releases/latest \
    | grep '"tag_name"' | cut -d'"' -f4 || echo "")
  if [[ -z "$ZVELTIO_VERSION" ]]; then
    warn "No release found — will build from main branch"
    ZVELTIO_VERSION="main"
  fi
  info "Target version: ${ZVELTIO_VERSION}"
fi

CURRENT_VERSION="unknown"
[[ -f "${ZVELTIO_DIR}/.version" ]] && CURRENT_VERSION=$(cat "${ZVELTIO_DIR}/.version")

if [[ "$CURRENT_VERSION" == "$ZVELTIO_VERSION" ]]; then
  success "Already on ${ZVELTIO_VERSION} — nothing to do."
  exit 0
fi

info "Updating: ${CURRENT_VERSION} → ${ZVELTIO_VERSION}"

# ── Detect install mode ───────────────────────────────────────────────────────
if [[ -f "${ZVELTIO_DIR}/docker-compose.yml" ]] && command -v docker &>/dev/null; then
  UPDATE_MODE="docker"
  info "Detected Docker install"
elif [[ -f "${ZVELTIO_DIR}/zveltio" ]] || [[ -f "${ZVELTIO_DIR}/index.js" ]]; then
  UPDATE_MODE="native"
  info "Detected native install"
else
  error "Cannot detect install mode. Is Zveltio installed in ${ZVELTIO_DIR}?"
  exit 1
fi

# =============================================================================
# DOCKER UPDATE
# =============================================================================
if [[ "$UPDATE_MODE" == "docker" ]]; then
  cd "${ZVELTIO_DIR}"

  info "Pulling latest images..."
  docker compose pull

  info "Restarting with new images..."
  docker compose up -d

  sleep 5

  info "Running migrations..."
  docker compose exec -T engine zveltio migrate

  success "Zveltio updated (Docker)"
  echo "$ZVELTIO_VERSION" > "${ZVELTIO_DIR}/.version"

  header "Update complete: ${CURRENT_VERSION} → ${ZVELTIO_VERSION}"
  echo -e "  Logs:   docker compose -f ${ZVELTIO_DIR}/docker-compose.yml logs -f engine"
  echo ""
  exit 0
fi

# =============================================================================
# NATIVE UPDATE
# =============================================================================

# ── Stop service ──────────────────────────────────────────────────────────────
info "Stopping Zveltio..."
systemctl stop zveltio

# ── Backup current binary/engine ─────────────────────────────────────────────
BACKUP_DIR="${ZVELTIO_DIR}/backups/engine-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
[[ -f "${ZVELTIO_DIR}/zveltio" ]] && cp "${ZVELTIO_DIR}/zveltio" "${BACKUP_DIR}/"
[[ -d "${ZVELTIO_DIR}/engine" ]]  && cp -r "${ZVELTIO_DIR}/engine" "${BACKUP_DIR}/"
info "Backed up to ${BACKUP_DIR}"

# ── Download or build ─────────────────────────────────────────────────────────
BINARY_INSTALLED=false

if [[ "$ZVELTIO_VERSION" != "main" ]]; then
  BINARY_URL="https://github.com/zveltio/zveltio/releases/download/${ZVELTIO_VERSION}/zveltio-linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
  if curl -fsSL --head "$BINARY_URL" &>/dev/null; then
    info "Downloading binary ${ZVELTIO_VERSION}..."
    wget -q "$BINARY_URL" -O "${ZVELTIO_DIR}/zveltio.new"
    mv "${ZVELTIO_DIR}/zveltio.new" "${ZVELTIO_DIR}/zveltio"
    chmod +x "${ZVELTIO_DIR}/zveltio"
    BINARY_INSTALLED=true
    success "Binary updated"
  fi
fi

if [[ "$BINARY_INSTALLED" == "false" ]]; then
  info "Building from source (branch: ${ZVELTIO_VERSION})..."
  BRANCH="$ZVELTIO_VERSION"
  [[ -z "$BRANCH" || "$BRANCH" == "latest" ]] && BRANCH="main"

  git clone --depth=1 --branch "$BRANCH" \
    https://github.com/zveltio/zveltio.git /tmp/zveltio-update
  cd /tmp/zveltio-update
  BUN_MEMORY_LIMIT=2048 bun install --frozen-lockfile
  cd packages/engine
  BUN_MEMORY_LIMIT=2048 bun run build:prod
  rm -rf "${ZVELTIO_DIR}/engine" 2>/dev/null || true
  mkdir -p "${ZVELTIO_DIR}/engine"
  cp -r dist/. "${ZVELTIO_DIR}/engine/"
  cp -r ../../extensions "${ZVELTIO_DIR}/" 2>/dev/null || true
  rm -rf /tmp/zveltio-update
  cd "${ZVELTIO_DIR}"
  success "Engine built from source"
fi

# ── Fix permissions ───────────────────────────────────────────────────────────
chown -R zveltio:zveltio "${ZVELTIO_DIR}" 2>/dev/null || true

# ── Run migrations ────────────────────────────────────────────────────────────
info "Running migrations..."
if [[ -f "${ZVELTIO_DIR}/zveltio" ]]; then
  sudo -u zveltio bash -c "cd ${ZVELTIO_DIR} && env \$(cat .env | xargs) ./zveltio migrate"
else
  sudo -u zveltio bash -c "cd ${ZVELTIO_DIR} && env \$(cat .env | xargs) bun engine/index.js migrate"
fi
success "Migrations complete"

# ── Track version + restart ───────────────────────────────────────────────────
echo "$ZVELTIO_VERSION" > "${ZVELTIO_DIR}/.version"
systemctl start zveltio
sleep 2

if systemctl is-active --quiet zveltio; then
  success "Zveltio ${ZVELTIO_VERSION} is running"
else
  error "Zveltio failed to start after update."
  error "Check logs: journalctl -u zveltio -n 50"
  error "Rollback:   cp -r ${BACKUP_DIR}/. ${ZVELTIO_DIR}/ && systemctl start zveltio"
  exit 1
fi

header "Update complete: ${CURRENT_VERSION} → ${ZVELTIO_VERSION}"
echo -e "  Logs:     journalctl -u zveltio -f"
echo -e "  Backup:   ${BACKUP_DIR}"
echo ""
