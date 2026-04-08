#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Zveltio Smart Installer
# https://get.zveltio.com
#
# Usage:
#   curl -fsSL https://get.zveltio.com/install.sh | bash
#   curl -fsSL https://get.zveltio.com/install.sh | bash -s -- --version 2.0.1
#   curl -fsSL https://get.zveltio.com/install.sh | bash -s -- --mode docker
#   curl -fsSL https://get.zveltio.com/install.sh | bash -s -- --mode native
#   curl -fsSL https://get.zveltio.com/install.sh | bash -s -- --mode infra-only
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Constante ─────────────────────────────────────────────────
REPO="zveltio-devs/zveltio"
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
  if [[ "$name" == "PostgreSQL" ]]; then
    echo ""
    warn "PostgreSQL auth failed. This usually means the data volume has a different password."
    warn "To reset: docker volume rm \$(docker volume ls -q | grep postgres_data)"
    warn "Then re-run the installer."
    echo ""
  fi
  if [[ "$name" == "Engine" ]]; then
    echo ""
    warn "Engine logs (last 30 lines):"
    docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" logs --tail=30 engine 2>/dev/null || true
    echo ""
  fi
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

if command_exists bun; then
  ok "Bun $(bun --version)"
fi

if [[ "$MODE" == "auto" ]]; then
  MODE="docker"
  info "→ Docker mode selected (full stack in containers)"
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
# A real completed install writes .zveltio-install.json at the very end.
# If only .env exists (e.g. a previous failed install), treat as fresh install
# so the create-god step is not skipped.
if [[ -f "${INSTALL_DIR}/.env" && -f "${INSTALL_DIR}/.zveltio-install.json" ]]; then
  IS_UPDATE=true
  EXISTING_VERSION=$(grep "^ZVELTIO_VERSION=" "${INSTALL_DIR}/.env" 2>/dev/null \
    | cut -d= -f2 || echo "unknown")
  warn "Existing installation detected (v${EXISTING_VERSION})"
  warn "This will UPGRADE to v${VERSION}"

  if [[ "$UNATTENDED" == "false" ]]; then
    echo -n "  Continue? (yes/no): "
    read -r confirm </dev/tty
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

  # If postgres volume already exists from a previous install, the new password
  # won't be applied (postgres ignores POSTGRES_PASSWORD when data dir exists).
  # We must remove the volume so postgres re-initializes with the new credentials.
  POSTGRES_VOLUME="${INSTALL_DIR##*/}_postgres_data"
  # Also check common compose project name (directory basename)
  COMPOSE_PROJECT=$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  for vol in "${COMPOSE_PROJECT}_postgres_data" "zveltio_postgres_data" "postgres_data"; do
    if docker volume ls -q 2>/dev/null | grep -qx "$vol"; then
      warn "Found existing postgres volume ($vol) — removing to avoid auth mismatch"
      docker volume rm "$vol" 2>/dev/null || true
    fi
  done

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
PGDOG_PORT=6432
DATABASE_URL=postgres://zveltio:${POSTGRES_PASS}@localhost:5432/zveltio?sslmode=disable

# ── Cache ──────────────────────────────────────────────────────
VALKEY_PORT=6379
VALKEY_URL=redis://localhost:6379

# ── Storage ────────────────────────────────────────────────────
S3_PORT=8333
S3_ENDPOINT=http://localhost:8333
S3_ACCESS_KEY=zveltio
S3_SECRET_KEY=${S3_SECRET}
S3_BUCKET=zveltio

# ── Ports ──────────────────────────────────────────────────────
CLIENT_PORT=4173
STUDIO_PORT=4174

# ── Engine ─────────────────────────────────────────────────────
PORT=${DEFAULT_PORT}
SECRET_KEY=${SECRET_KEY}
BETTER_AUTH_SECRET=$(generate_secret 32)
NODE_ENV=production
ZVELTIO_VERSION=${VERSION}
# Extensions are managed via Studio → Marketplace after deployment

# ── Security ───────────────────────────────────────────────────
# Required if mail extension is enabled (IMAP/SMTP password encryption)
MAIL_ENCRYPTION_KEY=$(generate_secret 32)
# Required if AI extension is enabled (AI API key encryption)
AI_KEY_ENCRYPTION_KEY=$(generate_secret 32)
# Optional: uncomment to protect /metrics endpoint
# METRICS_TOKEN=$(generate_secret 32)

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

# ── Fix DATABASE_URL for native mode ─────────────────────────
# .env has `localhost` (works inside containers via Unix socket), but the
# binary on the host must reach Postgres via TCP — 127.0.0.1, not localhost,
# because on many systems localhost resolves to ::1 (IPv6) which may not be
# bound.  We also keep ?sslmode=disable so Bun.SQL skips SSL negotiation
# (plain local Postgres has no SSL configured).
DATABASE_URL="${DATABASE_URL//localhost/127.0.0.1}"
export DATABASE_URL

# Detect server LAN IP (used in success message)
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")

# ── Download fișiere ──────────────────────────────────────────
section "⬇️  Downloading v${VERSION}"

if [[ "$MODE" == "docker" ]]; then
  curl -fsSL "${RELEASE_URL}/docker-compose.yml" -o docker-compose.yml
  ok "docker-compose.yml"
  info "→ Studio and Client are bundled inside the Docker image"
elif [[ "$MODE" == "native" ]] || [[ "$MODE" == "infra-only" ]]; then
  curl -fsSL "${RELEASE_URL}/docker-compose.infra.yml" -o docker-compose.infra.yml
  ok "docker-compose.infra.yml"

  # Native mode: download Studio + Client static files served by the binary at runtime
  echo -n "  Downloading Studio..."
  if curl -fsSL "${RELEASE_URL}/studio.tar.gz" -o studio.tar.gz 2>/dev/null; then
    mkdir -p studio-dist && tar -xzf studio.tar.gz -C studio-dist && rm studio.tar.gz
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${YELLOW}⚠ studio.tar.gz not found${NC}"
  fi

  echo -n "  Downloading Client..."
  if curl -fsSL "${RELEASE_URL}/client.tar.gz" -o client.tar.gz 2>/dev/null; then
    mkdir -p client-dist && tar -xzf client.tar.gz -C client-dist && rm client.tar.gz
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${YELLOW}⚠ client.tar.gz not found${NC}"
  fi
fi

if [[ "$MODE" == "native" ]]; then
  PLATFORM=$(get_platform)
  BINARY_NAME="zveltio-${PLATFORM}"

  echo -n "  Downloading binary for ${PLATFORM}..."
  curl -fsSL "${RELEASE_URL}/${BINARY_NAME}" -o zveltio-engine 2>/dev/null
  chmod +x zveltio-engine
  echo -e " ${GREEN}✓${NC}"

  # For Linux x64: test if CPU supports modern binary, fall back to baseline if not
  if [[ "$PLATFORM" == "linux-x64" ]]; then
    if ! ./zveltio-engine --version &>/dev/null 2>&1; then
      warn "CPU requires baseline binary (no AVX2), downloading..."
      curl -fsSL "${RELEASE_URL}/zveltio-linux-x64-baseline" -o zveltio-engine 2>/dev/null
      chmod +x zveltio-engine
      BINARY_NAME="zveltio-linux-x64-baseline"
      ok "Baseline binary ready"
    fi
  fi

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

# ── Infrastructură + Engine ───────────────────────────────────
if [[ "$SKIP_INFRA" == "false" ]]; then
  section "🐳 Starting Services"

  COMPOSE_FILE="docker-compose.yml"
  [[ "$MODE" == "native" || "$MODE" == "infra-only" ]] && COMPOSE_FILE="docker-compose.infra.yml"

  log "Pulling Docker images..."
  docker compose -f "$COMPOSE_FILE" pull

  if [[ "$IS_UPDATE" == "true" ]]; then
    log "Stopping previous version..."
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
  fi

  if [[ "$MODE" == "docker" ]]; then
    # 1. Start infra first, wait for it to be healthy
    docker compose -f "$COMPOSE_FILE" up -d postgres pgdog-init pgdog valkey \
      seaweedfs-master seaweedfs-volume seaweedfs-filer
    # Use auth test (not just pg_isready) — pg_isready returns OK before auth is ready
    wait_for_service "PostgreSQL" \
      "docker compose -f $COMPOSE_FILE exec -T postgres psql -U ${POSTGRES_USER:-zveltio} -d ${POSTGRES_DB:-zveltio} -c 'SELECT 1' -q" 60
    wait_for_service "Valkey" \
      "docker compose -f $COMPOSE_FILE exec -T valkey valkey-cli ping"
    ok "Infrastructure running"

    # 2. Migrations (run-and-exit container)
    section "🗄️  Database Migrations"
    docker compose -f "$COMPOSE_FILE" run -T --rm \
      -e DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-zveltio}?sslmode=disable" \
      engine migrate
    ok "Migrations complete"

    # 3. Create admin account (fresh install only)
    if [[ "$IS_UPDATE" == "false" && "$SKIP_ENGINE" == "false" ]]; then
      section "👤 Create Admin Account"
      if [[ "$UNATTENDED" == "false" ]]; then
        echo -n "  Email: "
        read -r ADMIN_EMAIL </dev/tty
        echo -n "  Password: "
        read -rs ADMIN_PASSWORD </dev/tty
        echo ""
      else
        ADMIN_EMAIL="${ADMIN_EMAIL:-admin@zveltio.local}"
        ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(generate_secret 16)}"
        info "Admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"
        info "(save these credentials!)"
      fi
      docker compose -f "$COMPOSE_FILE" run -T --rm \
        -e DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-zveltio}?sslmode=disable" \
        engine create-god \
        --email "$ADMIN_EMAIL" \
        --password "$ADMIN_PASSWORD"
      ok "Admin account created"
    fi

    # 4. Wait for PgDog connection pool to be fully established
    wait_for_service "PgDog" \
      "docker compose -f $COMPOSE_FILE exec -T postgres pg_isready -h pgdog -p 6432 -U ${POSTGRES_USER:-zveltio}" 60

    # 5. Start engine
    if [[ "$SKIP_ENGINE" == "false" ]]; then
      section "🚀 Starting Zveltio"
      docker compose -f "$COMPOSE_FILE" up -d engine
      wait_for_service "Engine" \
        "curl -sf http://localhost:${PORT:-3000}/health" 120
      ok "Engine running"
    fi

  else
    # Native / infra-only mode — start all infra containers
    docker compose -f "$COMPOSE_FILE" up -d
    # Use auth test (not just pg_isready) — pg_isready returns OK before auth is ready
    wait_for_service "PostgreSQL" \
      "docker compose -f $COMPOSE_FILE exec -T postgres psql -U ${POSTGRES_USER:-zveltio} -d ${POSTGRES_DB:-zveltio} -c 'SELECT 1' -q" 60
    wait_for_service "Valkey" \
      "docker compose -f $COMPOSE_FILE exec -T valkey valkey-cli ping"
    ok "Infrastructure running"

    if [[ "$MODE" == "native" && "$SKIP_ENGINE" == "false" ]]; then
      section "🗄️  Database Migrations"

      # Verify TCP connectivity from the host (psql inside container uses Unix socket,
      # so wait_for_service "PostgreSQL" passing does NOT guarantee the TCP port is ready)
      echo -n "   Waiting for postgres TCP on 127.0.0.1:${POSTGRES_PORT:-5432}"
      for _i in $(seq 1 30); do
        if bash -c "echo > /dev/tcp/127.0.0.1/${POSTGRES_PORT:-5432}" 2>/dev/null; then
          echo -e " ${GREEN}✓${NC}"; break
        fi
        echo -n "."; sleep 1
        if [[ $_i -eq 30 ]]; then
          echo -e " ${RED}✗${NC}"
          error "Postgres TCP port not reachable from host on 127.0.0.1:${POSTGRES_PORT:-5432}. Check Docker port bindings."
        fi
      done

      # DATABASE_URL is already fixed (127.0.0.1 + ?sslmode=disable) from the
      # source .env + substitution above — use it directly for all commands.
      info "Using DATABASE_URL: ${DATABASE_URL%%:*}://***@${DATABASE_URL#*@}"
      ./zveltio-engine migrate
      ok "Migrations complete"

      if [[ "$IS_UPDATE" == "false" ]]; then
        section "👤 Create Admin Account"
        if [[ "$UNATTENDED" == "false" ]]; then
          echo -n "  Email: "
          read -r ADMIN_EMAIL </dev/tty
          echo -n "  Password: "
          read -rs ADMIN_PASSWORD </dev/tty
          echo ""
        else
          ADMIN_EMAIL="${ADMIN_EMAIL:-admin@zveltio.local}"
          ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(generate_secret 16)}"
          info "Admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"
          info "(save these credentials!)"
        fi
        ./zveltio-engine create-god \
          --email "$ADMIN_EMAIL" \
          --password "$ADMIN_PASSWORD"
        ok "Admin account created"
      fi

      section "🚀 Starting Zveltio"
      if [[ -f ".zveltio.pid" ]]; then
        kill "$(cat .zveltio.pid)" 2>/dev/null || true
        sleep 1
      fi
      nohup env \
        DATABASE_URL="${DATABASE_URL}" \
        VALKEY_URL="redis://localhost:${VALKEY_PORT:-6379}" \
        S3_ENDPOINT="http://localhost:${S3_PORT:-8333}" \
        S3_ACCESS_KEY="${S3_ACCESS_KEY:-zveltio}" \
        S3_SECRET_KEY="${S3_SECRET_KEY}" \
        S3_BUCKET="${S3_BUCKET:-zveltio}" \
        PORT="${PORT:-3000}" \
        SECRET_KEY="${SECRET_KEY}" \
        NODE_ENV="production" \
        ZVELTIO_VERSION="${VERSION}" \
        ./zveltio-engine \
        > zveltio.log 2>&1 &
      echo $! > .zveltio.pid
      wait_for_service "Engine" \
        "curl -sf http://localhost:${PORT:-3000}/health"
      ok "Engine running"
    fi
  fi
fi

# ── Optional Add-ons ──────────────────────────────────────────
DOMAIN=""
INSTALL_NPM=false
NPM_PORT=81

ADDONS_CONFIGURED=false
[[ -f ".zveltio-install.json" ]] && grep -q '"addons_configured":true' .zveltio-install.json 2>/dev/null && ADDONS_CONFIGURED=true

if [[ "$UNATTENDED" == "false" && "$ADDONS_CONFIGURED" == "false" ]]; then
  section "🌐 Configuration"

  echo -n "  Your domain (e.g. example.com) — leave blank to use IP only: "
  read -r DOMAIN </dev/tty || true
  DOMAIN="${DOMAIN,,}"  # lowercase
  [[ -n "$DOMAIN" ]] && ok "Domain: ${DOMAIN}"

  section "🔧 Optional Add-ons"

  echo -e "  ${BOLD}Nginx Proxy Manager${NC} — reverse proxy with SSL ${GREEN}[recommended]${NC}"
  if [[ -z "$DOMAIN" ]]; then
    echo -e "  ${DIM}  Tip: set a domain above to get auto-configured proxy hosts${NC}"
  fi
  echo -n "  Install? (Y/n): "
  read -r ans </dev/tty || true
  [[ "${ans,,}" != "n" ]] && INSTALL_NPM=true
fi

if [[ "$INSTALL_NPM" == "true" ]]; then
  section "📦 Installing Add-ons"

  EXTRAS_COMPOSE="${INSTALL_DIR}/docker-compose.extras.yml"

  cat > "$EXTRAS_COMPOSE" << EXTRAS_EOF
# Zveltio — Optional Add-ons
# Manage with: docker compose -f docker-compose.extras.yml up -d

services:
  nginx-proxy-manager:
    image: jc21/nginx-proxy-manager:latest
    container_name: zveltio-npm
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "${NPM_PORT:-81}:81"
    volumes:
      - npm_data:/data
      - npm_letsencrypt:/etc/letsencrypt
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - npm_network

volumes:
  npm_data:
  npm_letsencrypt:

networks:
  npm_network:
    name: npm_network
    driver: bridge
EXTRAS_EOF

  ok "Nginx Proxy Manager added"
  log "Starting add-ons..."
  docker compose -f "$EXTRAS_COMPOSE" up -d
  ok "Add-ons running"

  # ── NPM auto-proxy via API ─────────────────────────────────
  if [[ -n "$DOMAIN" ]]; then
    section "🔀 Configuring Nginx Proxy Manager"
    log "Waiting for NPM API..."
    NPM_URL="http://localhost:${NPM_PORT:-81}"
    NPM_API="${NPM_URL}/api"

    for i in $(seq 1 30); do
      if curl -sf "${NPM_API}/nginx/proxy-hosts" &>/dev/null 2>&1; then break; fi
      sleep 2
    done

    NPM_TOKEN=$(curl -sf -X POST "${NPM_API}/tokens" \
      -H "Content-Type: application/json" \
      -d '{"identity":"admin@example.com","secret":"changeme"}' \
      2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || echo "")

    if [[ -n "$NPM_TOKEN" ]]; then
      HOST_IP="host.docker.internal"

      _npm_proxy() {
        local domain="$1" host="$2" port="$3"
        curl -sf -X POST "${NPM_API}/nginx/proxy-hosts" \
          -H "Authorization: Bearer ${NPM_TOKEN}" \
          -H "Content-Type: application/json" \
          -d "{\"domain_names\":[\"${domain}\"],\"forward_scheme\":\"http\",\"forward_host\":\"${host}\",\"forward_port\":${port},\"ssl_forced\":false,\"caching_enabled\":false,\"block_exploits\":true}" \
          &>/dev/null || true
      }

      _npm_proxy "${DOMAIN}" "$HOST_IP" "${PORT:-3000}" && ok "${DOMAIN} → zveltio"

      ok "Proxy hosts created — enable SSL in NPM admin after DNS propagates"
    else
      warn "Could not authenticate to NPM API — configure proxy hosts manually at http://localhost:${NPM_PORT:-81}"
    fi
  fi
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
if [[ -n "$DOMAIN" ]]; then
echo -e "  ${BOLD}App:${NC}      http://${DOMAIN}"
echo -e "  ${BOLD}Studio:${NC}   http://${DOMAIN}/admin/"
echo -e "  ${BOLD}API:${NC}      http://${DOMAIN}/api/"
else
echo -e "  ${BOLD}App:${NC}      http://localhost:${PORT_FINAL}"
echo -e "  ${BOLD}Studio:${NC}   http://localhost:${PORT_FINAL}/admin/"
echo -e "  ${BOLD}API:${NC}      http://localhost:${PORT_FINAL}/api/"
if [[ -n "$SERVER_IP" && "$SERVER_IP" != "127.0.0.1" ]]; then
echo ""
echo -e "  ${BOLD}App (LAN):${NC}    http://${SERVER_IP}:${PORT_FINAL}"
echo -e "  ${BOLD}Studio (LAN):${NC} http://${SERVER_IP}:${PORT_FINAL}/admin/"
fi
fi
echo ""
if [[ "$INSTALL_NPM" == "true" ]]; then
echo -e "  ${BOLD}Nginx Proxy Manager:${NC}  http://localhost:${NPM_PORT:-81}"
echo -e "  ${DIM}  Default login: admin@example.com / changeme${NC}"
echo -e "  ${DIM}  ⚠  Change password immediately after first login!${NC}"
echo ""
echo -e "  ${BOLD}NPM → Reverse Proxy setup:${NC}"
echo -e "  ${DIM}  1. Create proxy host: domain.com → http://localhost:${PORT_FINAL}${NC}"
echo -e "  ${DIM}  2. To protect /admin/ (studio) by IP, add custom nginx config:${NC}"
echo -e "  ${DIM}     location /admin/ {${NC}"
echo -e "  ${DIM}       allow 192.168.0.0/24;  # your LAN subnet${NC}"
echo -e "  ${DIM}       allow 10.0.0.0/8;       # VPN range (if any)${NC}"
echo -e "  ${DIM}       deny all;${NC}"
echo -e "  ${DIM}       proxy_pass http://localhost:${PORT_FINAL};${NC}"
echo -e "  ${DIM}     }${NC}"
echo ""
fi
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
  "port": ${PORT_FINAL},
  "domain": "${DOMAIN}",
  "addons_configured": true,
  "addons": {
    "npm": ${INSTALL_NPM}
  }
}
EOF
