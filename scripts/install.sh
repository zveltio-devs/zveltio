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
  MODE="native"
  info "→ Native mode selected (binary + Docker infra)"
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

  echo -n "  Downloading Studio..."
  if curl -fsSL "${RELEASE_URL}/studio.tar.gz" -o studio.tar.gz 2>/dev/null; then
    mkdir -p studio-dist
    tar -xzf studio.tar.gz -C studio-dist
    rm studio.tar.gz
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${YELLOW}⚠ Studio not bundled in this release${NC}"
  fi

  echo -n "  Downloading Client..."
  if curl -fsSL "${RELEASE_URL}/client.tar.gz" -o client.tar.gz 2>/dev/null; then
    mkdir -p client-dist
    tar -xzf client.tar.gz -C client-dist
    rm client.tar.gz
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${YELLOW}⚠ Client not bundled in this release${NC}"
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
    docker compose -f "$COMPOSE_FILE" up -d postgres pgdog-init pgdog valkey \
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
  DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-zveltio}?sslmode=disable" \
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

  if [[ "$MODE" == "native" ]]; then
    DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-zveltio}?sslmode=disable" \
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
      DATABASE_URL="postgres://${POSTGRES_USER:-zveltio}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-zveltio}?sslmode=disable" \
      REDIS_URL="redis://localhost:${VALKEY_PORT:-6379}" \
      S3_ENDPOINT="http://localhost:${S3_PORT:-8333}" \
      S3_ACCESS_KEY="${S3_ACCESS_KEY:-zveltio}" \
      S3_SECRET_KEY="${S3_SECRET_KEY}" \
      S3_BUCKET="${S3_BUCKET:-zveltio}" \
      PORT="${PORT:-3000}" \
      SECRET_KEY="${SECRET_KEY}" \
      NODE_ENV="production" \
      ZVELTIO_VERSION="${VERSION}" \
      ./zveltio-engine start \
      > zveltio.log 2>&1 &

    echo $! > .zveltio.pid
    wait_for_service "Engine" \
      "curl -sf http://localhost:${PORT:-3000}/health"

  elif [[ "$MODE" == "docker" ]]; then
    docker compose -f docker-compose.yml up -d engine
    wait_for_service "Engine" \
      "curl -sf http://localhost:${PORT:-3000}/health"
  fi

  ok "Engine running"
fi

# ── Optional Add-ons ──────────────────────────────────────────
DOMAIN=""
INSTALL_STALWART=false
INSTALL_DOCKGE=false
INSTALL_NPM=false
NPM_PORT=81
DOCKGE_PORT=5001

ADDONS_CONFIGURED=false
[[ -f ".zveltio-install.json" ]] && grep -q '"addons_configured":true' .zveltio-install.json 2>/dev/null && ADDONS_CONFIGURED=true

if [[ "$UNATTENDED" == "false" && "$ADDONS_CONFIGURED" == "false" ]]; then
  section "🌐 Configuration"

  echo -n "  Your domain (e.g. example.com) — leave blank to use IP only: "
  read -r DOMAIN </dev/tty || true
  DOMAIN="${DOMAIN,,}"  # lowercase
  [[ -n "$DOMAIN" ]] && ok "Domain: ${DOMAIN}"

  section "🔧 Optional Add-ons"

  echo -e "  ${BOLD}Stalwart Mail Server${NC} — self-hosted SMTP/IMAP (own your email)"
  echo -n "  Install? (y/N): "
  read -r ans </dev/tty || true
  [[ "${ans,,}" == "y" ]] && INSTALL_STALWART=true

  echo ""
  echo -e "  ${BOLD}Dockge${NC} — web UI for managing Docker Compose stacks ${GREEN}[recommended]${NC}"
  echo -n "  Install? (Y/n): "
  read -r ans </dev/tty || true
  [[ "${ans,,}" != "n" ]] && INSTALL_DOCKGE=true

  echo ""
  echo -e "  ${BOLD}Nginx Proxy Manager${NC} — reverse proxy with SSL ${GREEN}[recommended]${NC}"
  if [[ -z "$DOMAIN" ]]; then
    echo -e "  ${DIM}  Tip: set a domain above to get auto-configured proxy hosts${NC}"
  fi
  echo -n "  Install? (Y/n): "
  read -r ans </dev/tty || true
  [[ "${ans,,}" != "n" ]] && INSTALL_NPM=true
fi

if [[ "$INSTALL_STALWART" == "true" || "$INSTALL_DOCKGE" == "true" || "$INSTALL_NPM" == "true" ]]; then
  section "📦 Installing Add-ons"

  EXTRAS_COMPOSE="${INSTALL_DIR}/docker-compose.extras.yml"

  cat > "$EXTRAS_COMPOSE" << 'EXTRAS_EOF'
# Zveltio — Optional Add-ons
# Manage with: docker compose -f docker-compose.extras.yml up -d

services:
EXTRAS_EOF

  if [[ "$INSTALL_STALWART" == "true" ]]; then
    cat >> "$EXTRAS_COMPOSE" << EXTRAS_EOF
  stalwart-mail:
    image: stalwartlabs/stalwart:latest
    container_name: stalwart-mail
    restart: unless-stopped
    ports:
      - "25:25"
      - "587:587"
      - "465:465"
      - "143:143"
      - "993:993"
      - "4190:4190"
      - "110:110"
      - "995:995"
    volumes:
      - ./stalwart-data:/opt/stalwart
    networks:
      - npm_network

EXTRAS_EOF
    ok "Stalwart Mail Server added"
  fi

  if [[ "$INSTALL_DOCKGE" == "true" ]]; then
    cat >> "$EXTRAS_COMPOSE" << EXTRAS_EOF
  dockge:
    image: louislam/dockge:1
    container_name: zveltio-dockge
    restart: unless-stopped
    ports:
      - "${DOCKGE_PORT:-5001}:5001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - dockge_data:/app/data
      - /opt/stacks:/opt/stacks

EXTRAS_EOF
    ok "Dockge added"
  fi

  if [[ "$INSTALL_NPM" == "true" ]]; then
    cat >> "$EXTRAS_COMPOSE" << EXTRAS_EOF
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

EXTRAS_EOF
    ok "Nginx Proxy Manager added"
  fi

  # volumes + networks block
  {
    echo "volumes:"
    [[ "$INSTALL_DOCKGE" == "true" ]]   && echo "  dockge_data:"
    [[ "$INSTALL_NPM" == "true" ]]      && echo "  npm_data:" && echo "  npm_letsencrypt:"
    echo ""
    echo "networks:"
    echo "  npm_network:"
    echo "    name: npm_network"
    echo "    driver: bridge"
  } >> "$EXTRAS_COMPOSE"

  log "Starting add-ons..."
  docker compose -f "$EXTRAS_COMPOSE" up -d
  ok "Add-ons running"

  # ── NPM auto-proxy via API ─────────────────────────────────
  if [[ "$INSTALL_NPM" == "true" && -n "$DOMAIN" ]]; then
    section "🔀 Configuring Nginx Proxy Manager"
    log "Waiting for NPM API..."
    NPM_URL="http://localhost:${NPM_PORT:-81}"
    NPM_API="${NPM_URL}/api"

    # Wait up to 60s for NPM
    for i in $(seq 1 30); do
      if curl -sf "${NPM_API}/nginx/proxy-hosts" &>/dev/null 2>&1; then break; fi
      sleep 2
    done

    # Get auth token (default credentials)
    NPM_TOKEN=$(curl -sf -X POST "${NPM_API}/tokens" \
      -H "Content-Type: application/json" \
      -d '{"identity":"admin@example.com","secret":"changeme"}' \
      2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || echo "")

    if [[ -n "$NPM_TOKEN" ]]; then
      HOST_IP="host.docker.internal"
      CLIENT_PORT_VAL="${CLIENT_PORT:-4173}"
      STUDIO_PORT_VAL="${STUDIO_PORT:-4174}"
      ENGINE_PORT_VAL="${PORT:-3000}"
      DOCKGE_PORT_VAL="${DOCKGE_PORT:-5001}"

      _npm_proxy() {
        local domain="$1" host="$2" port="$3"
        curl -sf -X POST "${NPM_API}/nginx/proxy-hosts" \
          -H "Authorization: Bearer ${NPM_TOKEN}" \
          -H "Content-Type: application/json" \
          -d "{\"domain_names\":[\"${domain}\"],\"forward_scheme\":\"http\",\"forward_host\":\"${host}\",\"forward_port\":${port},\"ssl_forced\":false,\"caching_enabled\":false,\"block_exploits\":true}" \
          &>/dev/null || true
      }

      _npm_proxy "${DOMAIN}"               "$HOST_IP" "$CLIENT_PORT_VAL"  && ok "${DOMAIN} → client"
      _npm_proxy "studio.${DOMAIN}"        "$HOST_IP" "$STUDIO_PORT_VAL"  && ok "studio.${DOMAIN} → studio"
      _npm_proxy "api.${DOMAIN}"           "$HOST_IP" "$ENGINE_PORT_VAL"  && ok "api.${DOMAIN} → engine"
      [[ "$INSTALL_DOCKGE" == "true" ]]   && _npm_proxy "dockge.${DOMAIN}"   "$HOST_IP" "$DOCKGE_PORT_VAL"  && ok "dockge.${DOMAIN} → dockge"
      [[ "$INSTALL_STALWART" == "true" ]] && _npm_proxy "mail.${DOMAIN}"     "stalwart-mail" 8080 && ok "mail.${DOMAIN} → stalwart"

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
echo -e "  ${BOLD}Client:${NC}   http://${DOMAIN}  (→ https after NPM SSL setup)"
echo -e "  ${BOLD}Studio:${NC}   http://studio.${DOMAIN}"
echo -e "  ${BOLD}API:${NC}      http://api.${DOMAIN}"
else
echo -e "  ${BOLD}Client:${NC}   http://localhost:${CLIENT_PORT:-4173}"
echo -e "  ${BOLD}Studio:${NC}   http://localhost:${STUDIO_PORT:-4174}"
echo -e "  ${BOLD}API:${NC}      http://localhost:${PORT_FINAL}"
fi
echo ""
if [[ "$INSTALL_NPM" == "true" ]]; then
echo -e "  ${BOLD}Nginx Proxy Manager:${NC}  http://localhost:${NPM_PORT:-81}"
echo -e "  ${DIM}  Default login: admin@example.com / changeme${NC}"
echo -e "  ${DIM}  ⚠  Change password immediately after first login!${NC}"
echo ""
fi
if [[ "$INSTALL_DOCKGE" == "true" ]]; then
echo -e "  ${BOLD}Dockge:${NC}  http://localhost:${DOCKGE_PORT:-5001}"
echo ""
fi
if [[ "$INSTALL_STALWART" == "true" ]]; then
if [[ -n "$DOMAIN" ]]; then
echo -e "  ${BOLD}Stalwart Mail:${NC}  http://mail.${DOMAIN}  (via NPM)"
else
echo -e "  ${BOLD}Stalwart Mail:${NC}  acces via NPM → proxy intern stalwart-mail:8080"
fi
if [[ -n "$DOMAIN" ]]; then
echo ""
echo -e "  ${YELLOW}📧 DNS records to add at your registrar:${NC}"
echo -e "  ${DIM}  MX    ${DOMAIN}          mail.${DOMAIN}  (priority 10)${NC}"
echo -e "  ${DIM}  A     mail.${DOMAIN}     <your-server-IP>${NC}"
echo -e "  ${DIM}  TXT   ${DOMAIN}          v=spf1 mx ~all${NC}"
echo -e "  ${DIM}  TXT   _dmarc.${DOMAIN}   v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}${NC}"
echo -e "  ${DIM}  DKIM key → available in Stalwart admin after first login${NC}"
fi
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
    "stalwart": ${INSTALL_STALWART},
    "dockge": ${INSTALL_DOCKGE},
    "npm": ${INSTALL_NPM}
  }
}
EOF
