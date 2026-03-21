#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Zveltio Smart Installer
# https://get.zveltio.com
#
# Usage:
#   curl -fsSL https://get.zveltio.com | bash
#   curl -fsSL https://get.zveltio.com | bash -s -- --version 2.0.1
#   curl -fsSL https://get.zveltio.com | bash -s -- --mode docker
#   curl -fsSL https://get.zveltio.com | bash -s -- --mode native
#   curl -fsSL https://get.zveltio.com | bash -s -- --mode infra-only
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Constante ─────────────────────────────────────────────────
REPO="zveltio/zveltio"
RELEASES_BASE="https://github.com/${REPO}/releases/download"
DEFAULT_PORT=3000
INSTALL_DIR="$(pwd)/zveltio"

# ── Culori ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log()     { echo -e "${GREEN}▸${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC}  $*" >&2; exit 1; }
info()    { echo -e "${DIM}  $*${NC}"; }
section() { echo -e "\n${BOLD}${BLUE}── $* ──${NC}\n"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }

# ── Parse argumente ───────────────────────────────────────────
MODE="auto"
VERSION="latest"
SKIP_INFRA=false
SKIP_ENGINE=false
UNATTENDED=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --version|-v)    VERSION="$2"; shift 2 ;;
    --mode|-m)       MODE="$2"; shift 2 ;;
    --skip-infra)    SKIP_INFRA=true; shift ;;
    --skip-engine)   SKIP_ENGINE=true; shift ;;
    --unattended|-y) UNATTENDED=true; shift ;;
    --dir|-d)        INSTALL_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: install.sh [options]"
      echo "  --version <v>    Install specific version (default: latest)"
      echo "  --mode <m>       Mode: auto|docker|native|infra-only (default: auto)"
      echo "  --skip-infra     Skip infrastructure setup"
      echo "  --skip-engine    Setup infrastructure only"
      echo "  --unattended     Non-interactive mode"
      echo "  --dir <path>     Installation directory (default: ./zveltio)"
      exit 0 ;;
    *) warn "Unknown argument: $1"; shift ;;
  esac
done

# ── Banner ────────────────────────────────────────────────────
clear
echo -e "${BOLD}"
cat << 'BANNER'
  ╔═══════════════════════════════════════╗
  ║                                       ║
  ║          Z V E L T I O                ║
  ║        Business OS Platform           ║
  ║                                       ║
  ╚═══════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ── Funcții utilitare ─────────────────────────────────────────
command_exists() { command -v "$1" &>/dev/null; }

get_platform() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
    x86_64)        arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac
  case "$os" in
    linux)  echo "linux-${arch}" ;;
    darwin) echo "macos-${arch}" ;;
    *) error "Unsupported OS: $os. Use Docker on Windows." ;;
  esac
}

get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    2>/dev/null \
    | grep '"tag_name"' \
    | cut -d'"' -f4 \
    | tr -d 'v' \
  || echo "2.0.0"
}

verify_checksum() {
  local file="$1" expected="$2"
  local actual
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    error "Checksum mismatch for $file!\n  Expected: $expected\n  Got:      $actual"
  fi
}

generate_secret() {
  openssl rand -hex "${1:-32}" 2>/dev/null \
    || dd if=/dev/urandom bs=1 count="${1:-32}" 2>/dev/null | xxd -p | tr -d '\n'
}

wait_for_service() {
  local name="$1" cmd="$2" max="${3:-30}"
  echo -n "   Waiting for ${name}"
  for i in $(seq 1 "$max"); do
    if eval "$cmd" &>/dev/null; then
      echo -e " ${GREEN}✓${NC}"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo -e " ${RED}✗${NC}"
  error "${name} did not become ready in ${max}s"
}

# ── Detectare mediu ───────────────────────────────────────────
section "🔍 Detecting Environment"

if ! command_exists docker; then
  error "Docker is required.\nInstall from: https://docs.docker.com/get-docker/"
fi
ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"

if ! docker compose version &>/dev/null; then
  error "Docker Compose v2 required.\nUpdate Docker Desktop or install the plugin."
fi
ok "Docker Compose $(docker compose version --short)"

HAS_BUN=false
if command_exists bun; then
  HAS_BUN=true
  ok "Bun $(bun --version)"
else
  warn "Bun not found (native mode unavailable)"
fi

if [[ "$MODE" == "auto" ]]; then
  if [[ "$HAS_BUN" == "true" ]]; then
    MODE="native"
    info "→ Native mode selected (Bun detected)"
  else
    MODE="docker"
    info "→ Docker mode selected (Bun not found)"
  fi
fi

echo ""
echo -e "  Mode: ${BOLD}${MODE}${NC}"

if [[ "$VERSION" == "latest" ]]; then
  echo -n "  Fetching latest version..."
  VERSION=$(get_latest_version)
  echo -e " ${GREEN}v${VERSION}${NC}"
else
  echo -e "  Version: ${BOLD}v${VERSION}${NC}"
fi

RELEASE_URL="${RELEASES_BASE}/v${VERSION}"

# ── Setup director ────────────────────────────────────────────
section "📁 Setting Up Directory"

IS_UPDATE=false
if [[ -f "${INSTALL_DIR}/.env" ]]; then
  IS_UPDATE=true
  EXISTING_VERSION=$(grep "^ZVELTIO_VERSION=" "${INSTALL_DIR}/.env" 2>/dev/null \
    | cut -d= -f2 || echo "unknown")
  warn "Existing installation detected (v${EXISTING_VERSION})"
  warn "This will UPGRADE to v${VERSION}"

  if [[ "$UNATTENDED" == "false" ]]; then
    echo -n "  Continue? (yes/no): "
    read -r confirm
    [[ "$confirm" != "yes" ]] && { echo "  Cancelled."; exit 0; }
  fi

  cp "${INSTALL_DIR}/.env" "${INSTALL_DIR}/.env.backup.$(date +%Y%m%d%H%M%S)"
  ok "Backed up existing .env"
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
ok "Directory: $INSTALL_DIR"

# ── Generare .env ─────────────────────────────────────────────
section "⚙️  Configuration"

if [[ ! -f ".env" ]]; then
  log "Generating secure credentials..."

  POSTGRES_PASS=$(generate_secret 32)
  SECRET_KEY=$(generate_secret 64)
  S3_SECRET=$(generate_secret 32)

  cat > .env << EOF
# Zveltio v${VERSION} — Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# KEEP THIS FILE SAFE — contains your credentials

# ── Database ──────────────────────────────────────────────────
POSTGRES_USER=zveltio
POSTGRES_PASSWORD=${POSTGRES_PASS}
POSTGRES_DB=zveltio
POSTGRES_PORT=5432
PGBOUNCER_PORT=6432
DATABASE_URL=postgres://zveltio:${POSTGRES_PASS}@localhost:6432/zveltio

# ── Cache ──────────────────────────────────────────────────────
VALKEY_PORT=6379
REDIS_URL=redis://localhost:6379

# ── Storage ────────────────────────────────────────────────────
S3_PORT=8333
S3_ENDPOINT=http://localhost:8333
S3_ACCESS_KEY=zveltio
S3_SECRET_KEY=${S3_SECRET}
S3_BUCKET=zveltio

# ── Engine ─────────────────────────────────────────────────────
PORT=${DEFAULT_PORT}
SECRET_KEY=${SECRET_KEY}
BETTER_AUTH_SECRET=$(generate_secret 32)
NODE_ENV=production
SERVE_STUDIO=true
ZVELTIO_VERSION=${VERSION}
ZVELTIO_EXTENSIONS=ai/core-ai,automation/flows,workflow/approvals,workflow/checklists,content/page-builder,developer/edge-functions,developer/graphql,analytics/insights,data/export,data/import,i18n/translations,crm,communications/mail

# ── Monitoring ─────────────────────────────────────────────────
GRAFANA_ADMIN_PASSWORD=$(generate_secret 24)
GRAFANA_PORT=3001
PROMETHEUS_PORT=9090
EOF
  ok ".env generated with secure credentials"
else
  sed -i "s/^ZVELTIO_VERSION=.*/ZVELTIO_VERSION=${VERSION}/" .env
  ok ".env updated (version → ${VERSION})"
fi

source .env

# ── Download fișiere ──────────────────────────────────────────
section "⬇️  Downloading v${VERSION}"

if [[ "$MODE" == "native" ]] || [[ "$MODE" == "infra-only" ]]; then
  curl -fsSL "${RELEASE_URL}/docker-compose.infra.yml" \
    -o docker-compose.infra.yml
  ok "docker-compose.infra.yml"
fi

if [[ "$MODE" == "docker" ]]; then
  curl -fsSL "${RELEASE_URL}/docker-compose.yml" \
    -o docker-compose.yml
  ok "docker-compose.yml"
fi

if [[ "$MODE" == "native" ]]; then
  PLATFORM=$(get_platform)
  BINARY_NAME="zveltio-${PLATFORM}"
  BINARY_URL="${RELEASE_URL}/${BINARY_NAME}"

  echo -n "  Downloading binary for ${PLATFORM}..."
  curl -fsSL "$BINARY_URL" -o zveltio-engine 2>/dev/null
  chmod +x zveltio-engine
  echo -e " ${GREEN}✓${NC}"

  CHECKSUMS_URL="${RELEASE_URL}/checksums.sha256"
  if curl -fsSL "$CHECKSUMS_URL" -o checksums.sha256 2>/dev/null; then
    EXPECTED=$(grep "$BINARY_NAME" checksums.sha256 | cut -d' ' -f1)
    if [[ -n "$EXPECTED" ]]; then
      verify_checksum "zveltio-engine" "$EXPECTED"
      ok "Checksum verified"
    fi
  fi

  if [[ -w "/usr/local/bin" ]]; then
    ln -sf "$(pwd)/zveltio-engine" /usr/local/bin/zveltio
    ok "Installed to /usr/local/bin/zveltio"
  else
    warn "Add to PATH: export PATH=\"$(pwd):\$PATH\""
  fi
fi

# ── Infrastructură ────────────────────────────────────────────
if [[ "$SKIP_INFRA" == "false" ]]; then
  section "🐳 Starting Infrastructure"

  COMPOSE_FILE="docker-compose.infra.yml"
  if [[ "$MODE" == "docker" ]]; then
    COMPOSE_FILE="docker-compose.yml"
  fi

  log "Pulling Docker images..."
  docker compose -f "$COMPOSE_FILE" pull

  if [[ "$IS_UPDATE" == "true" ]]; then
    log "Stopping previous version..."
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
  fi

  if [[ "$MODE" == "docker" ]]; then
    docker compose -f "$COMPOSE_FILE" up -d postgres pgbouncer valkey \
      seaweedfs-master seaweedfs-volume seaweedfs-filer
  else
    docker compose -f "$COMPOSE_FILE" up -d
  fi

  wait_for_service "PostgreSQL" \
    "docker compose -f $COMPOSE_FILE exec -T postgres pg_isready -U ${POSTGRES_USER:-zveltio}"
  wait_for_service "Valkey" \
    "docker compose -f $COMPOSE_FILE exec -T valkey valkey-cli ping"

  ok "Infrastructure running"
fi

# ── Migrări ───────────────────────────────────────────────────
section "🗄️  Database Migrations"

if [[ "$IS_UPDATE" == "true" ]]; then
  log "Running upgrade migrations..."
else
  log "Initializing database..."
fi

if [[ "$MODE" == "native" ]]; then
  DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@localhost:${PGBOUNCER_PORT:-6432}/${POSTGRES_DB:-zveltio}" \
  ./zveltio-engine migrate
elif [[ "$MODE" == "docker" ]]; then
  docker compose -f docker-compose.yml run --rm engine migrate
fi

ok "Migrations complete"

# ── Admin user ────────────────────────────────────────────────
if [[ "$IS_UPDATE" == "false" ]]; then
  section "👤 Create Admin Account"

  if [[ "$UNATTENDED" == "false" ]]; then
    echo -n "  Email: "
    read -r ADMIN_EMAIL
    echo -n "  Password: "
    read -rs ADMIN_PASSWORD
    echo ""
  else
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@zveltio.local}"
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(generate_secret 16)}"
    info "Admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"
    info "(save these credentials!)"
  fi

  if [[ "$MODE" == "native" ]]; then
    DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@localhost:${PGBOUNCER_PORT:-6432}/${POSTGRES_DB:-zveltio}" \
    ./zveltio-engine create-god \
      --email "$ADMIN_EMAIL" \
      --password "$ADMIN_PASSWORD"
  elif [[ "$MODE" == "docker" ]]; then
    docker compose -f docker-compose.yml run --rm engine create-god \
      --email "$ADMIN_EMAIL" \
      --password "$ADMIN_PASSWORD"
  fi

  ok "Admin account created"
fi

# ── Pornire engine ────────────────────────────────────────────
if [[ "$SKIP_ENGINE" == "false" ]]; then
  section "🚀 Starting Zveltio"

  if [[ "$MODE" == "native" ]]; then
    if [[ -f ".zveltio.pid" ]]; then
      OLD_PID=$(cat .zveltio.pid)
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi

    nohup env \
      DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@localhost:${PGBOUNCER_PORT:-6432}/${POSTGRES_DB:-zveltio}" \
      REDIS_URL="redis://localhost:${VALKEY_PORT:-6379}" \
      S3_ENDPOINT="http://localhost:${S3_PORT:-8333}" \
      S3_ACCESS_KEY="${S3_ACCESS_KEY:-zveltio}" \
      S3_SECRET_KEY="${S3_SECRET_KEY}" \
      S3_BUCKET="${S3_BUCKET:-zveltio}" \
      PORT="${PORT:-3000}" \
      SECRET_KEY="${SECRET_KEY}" \
      SERVE_STUDIO="true" \
      NODE_ENV="production" \
      ZVELTIO_VERSION="${VERSION}" \
      ./zveltio-engine start \
      > zveltio.log 2>&1 &

    echo $! > .zveltio.pid
    wait_for_service "Engine" \
      "curl -sf http://localhost:${PORT:-3000}/api/health"

  elif [[ "$MODE" == "docker" ]]; then
    docker compose -f docker-compose.yml up -d engine
    wait_for_service "Engine" \
      "curl -sf http://localhost:${PORT:-3000}/api/health"
  fi

  ok "Engine running"
fi

# ── Success ───────────────────────────────────────────────────
PORT_FINAL="${PORT:-3000}"

echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔═══════════════════════════════════════════╗"
if [[ "$IS_UPDATE" == "true" ]]; then
echo "  ║   ✅  Upgraded to Zveltio v${VERSION}!        ║"
else
echo "  ║   ✅  Zveltio v${VERSION} installed!           ║"
fi
echo "  ╚═══════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${BOLD}Studio:${NC}   http://localhost:${PORT_FINAL}/studio"
echo -e "  ${BOLD}API:${NC}      http://localhost:${PORT_FINAL}/api"
echo -e "  ${BOLD}Docs:${NC}     http://localhost:${PORT_FINAL}/api/docs"
echo ""
echo -e "  ${BOLD}Data:${NC}     ${INSTALL_DIR}"
echo -e "  ${BOLD}Logs:${NC}     ${INSTALL_DIR}/zveltio.log"
echo ""
echo -e "  ${DIM}Commands:${NC}"
echo -e "  ${DIM}  zveltio status    — check services${NC}"
echo -e "  ${DIM}  zveltio logs      — view logs${NC}"
echo -e "  ${DIM}  zveltio update    — update to latest${NC}"
echo -e "  ${DIM}  zveltio stop      — stop Zveltio${NC}"
echo ""
echo -e "  ${YELLOW}Keep .env safe — it contains your credentials${NC}"
echo ""

cat > .zveltio-install.json << EOF
{
  "version": "${VERSION}",
  "mode": "${MODE}",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "install_dir": "${INSTALL_DIR}",
  "port": ${PORT_FINAL}
}
EOF
