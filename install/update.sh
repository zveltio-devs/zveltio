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
  # The /releases/latest endpoint EXCLUDES prereleases. Zveltio currently ships
  # only beta/rc tags, so /releases/latest returns nothing and we would wrongly
  # fall through to a source build of a branch that may not exist. Use the full
  # releases list (newest first, prereleases included) and take the top tag.
  ZVELTIO_VERSION=$(curl -fsSL "https://api.github.com/repos/zveltio-devs/zveltio/releases?per_page=1" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4 || echo "")
  if [[ -z "$ZVELTIO_VERSION" ]]; then
    warn "No release found — will build from the default branch"
    ZVELTIO_VERSION="master"
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

# ── Checksum verification ─────────────────────────────────────────────────────
# Every release publishes `checksums.sha256` (release.yml "Generate checksums"),
# and this script downloaded binaries and tarballs over the network without ever
# looking at it. TLS proves who served the bytes, not that they are the bytes the
# release was built from — a compromised or substituted asset installed silently,
# as root, and then ran as the engine.
#
# The checksum file is fetched once per run. If it cannot be fetched the update
# STOPS rather than proceeding unverified: an update is a deliberate act an
# operator can retry, and "carry on without checking" is how a verification step
# becomes decorative.
CHECKSUMS_FILE=""
fetch_checksums() {
  [[ -n "$CHECKSUMS_FILE" ]] && return 0
  local url="https://github.com/zveltio-devs/zveltio/releases/download/${ZVELTIO_VERSION}/checksums.sha256"
  CHECKSUMS_FILE="$(mktemp)"
  if ! wget -q "$url" -O "$CHECKSUMS_FILE"; then
    rm -f "$CHECKSUMS_FILE"; CHECKSUMS_FILE=""
    error "Could not download checksums.sha256 for ${ZVELTIO_VERSION}. Refusing to install unverified files."
    exit 1
  fi
}

# verify_download <file> <asset-name-as-published>
verify_download() {
  local file="$1" asset="$2"
  fetch_checksums
  local expected
  expected="$(awk -v a="$asset" '$2 == a || $2 == "*"a {print $1}' "$CHECKSUMS_FILE" | head -1)"
  if [[ -z "$expected" ]]; then
    error "No checksum published for ${asset} in ${ZVELTIO_VERSION}. Refusing to install it."
    rm -f "$file"; exit 1
  fi
  local actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    error "Checksum mismatch for ${asset}."
    error "  expected ${expected}"
    error "  got      ${actual}"
    error "The downloaded file is not what this release published. Not installing it."
    rm -f "$file"; exit 1
  fi
  info "Verified ${asset}"
}

# ── Download or build ─────────────────────────────────────────────────────────
BINARY_INSTALLED=false

if [[ "$ZVELTIO_VERSION" != "master" ]]; then
  BINARY_URL="https://github.com/zveltio-devs/zveltio/releases/download/${ZVELTIO_VERSION}/zveltio-linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
  if curl -fsSL --head "$BINARY_URL" &>/dev/null; then
    info "Downloading binary ${ZVELTIO_VERSION}..."
    wget -q "$BINARY_URL" -O "${ZVELTIO_DIR}/zveltio.new"
    verify_download "${ZVELTIO_DIR}/zveltio.new" "$(basename "$BINARY_URL")"
    mv "${ZVELTIO_DIR}/zveltio.new" "${ZVELTIO_DIR}/zveltio"
    chmod +x "${ZVELTIO_DIR}/zveltio"
    BINARY_INSTALLED=true
    success "Binary updated"
  fi
fi

if [[ "$BINARY_INSTALLED" == "false" ]]; then
  info "Building from source (branch: ${ZVELTIO_VERSION})..."
  BRANCH="$ZVELTIO_VERSION"
  [[ -z "$BRANCH" || "$BRANCH" == "latest" ]] && BRANCH="master"

  git clone --depth=1 --branch "$BRANCH" \
    https://github.com/zveltio-devs/zveltio.git /tmp/zveltio-update
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

# ── Refresh front-end bundles (Studio /admin + public web host /) ─────────────
# The engine binary does not carry the UIs. Without this step /admin stays on the
# old Studio build and the public web host at / (ADR 0001) is never installed —
# so shipping a front-end change would silently not land on update. Docker mode
# gets both from the image (compose pull), so this only applies to native.
# .env is preserved; we only append the CLIENT_DIST_PATH pointer if it's missing.
if [[ "$ZVELTIO_VERSION" != "master" ]]; then
  for pair in "studio.tar.gz:studio-dist" "client.tar.gz:client-dist"; do
    tarball="${pair%%:*}"; dest="${pair##*:}"
    url="https://github.com/zveltio-devs/zveltio/releases/download/${ZVELTIO_VERSION}/${tarball}"
    if curl -fsSL --head "$url" &>/dev/null; then
      info "Updating ${dest}..."
      wget -q "$url" -O "/tmp/${tarball}"
      verify_download "/tmp/${tarball}" "${tarball}"
      rm -rf "${ZVELTIO_DIR}/${dest}.new"; mkdir -p "${ZVELTIO_DIR}/${dest}.new"
      tar -xzf "/tmp/${tarball}" -C "${ZVELTIO_DIR}/${dest}.new"
      rm -rf "${ZVELTIO_DIR}/${dest}.old"
      [[ -d "${ZVELTIO_DIR}/${dest}" ]] && mv "${ZVELTIO_DIR}/${dest}" "${ZVELTIO_DIR}/${dest}.old"
      mv "${ZVELTIO_DIR}/${dest}.new" "${ZVELTIO_DIR}/${dest}"
      rm -f "/tmp/${tarball}"
      success "${dest} updated"
    else
      warn "${tarball} not available for ${ZVELTIO_VERSION} — skipping ${dest}"
    fi
  done
  if [[ -f "${ZVELTIO_DIR}/.env" ]] && ! grep -q '^CLIENT_DIST_PATH=' "${ZVELTIO_DIR}/.env"; then
    printf '\n# Public web host served at / (ADR 0001)\nCLIENT_DIST_PATH=%s/client-dist\n' \
      "${ZVELTIO_DIR}" >> "${ZVELTIO_DIR}/.env"
    info "Added CLIENT_DIST_PATH to .env"
  fi
fi

# ── Fix permissions ───────────────────────────────────────────────────────────
chown -R zveltio:zveltio "${ZVELTIO_DIR}" 2>/dev/null || true

# ── Run migrations ────────────────────────────────────────────────────────────
info "Running migrations..."
if [[ -f "${ZVELTIO_DIR}/zveltio" ]]; then
  sudo -u zveltio bash -c "cd ${ZVELTIO_DIR} && set -a && . ./.env && set +a && ./zveltio migrate"
else
  sudo -u zveltio bash -c "cd ${ZVELTIO_DIR} && set -a && . ./.env && set +a && bun engine/index.js migrate"
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
