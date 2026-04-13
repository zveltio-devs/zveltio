#!/usr/bin/env bash
# =============================================================================
# Zveltio — One-command Installer
# =============================================================================
# Auto-detects the best installation mode:
#   1. Docker   — preferred when Docker is available (WSL, VPS, any Linux)
#   2. Native   — direct install via Bun + systemd (bare-metal VPS/LXC)
#
# Usage:
#   curl -fsSL https://get.zveltio.com | bash
#
# Force a specific mode:
#   INSTALL_MODE=docker  bash install/install.sh
#   INSTALL_MODE=native  bash install/install.sh
#
# Override defaults:
#   ZVELTIO_PORT=4000 ZVELTIO_VERSION=v2.0.0 bash install/install.sh
#
# Supported OS: Ubuntu 22.04+, Debian 11/12
# =============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}${BLUE}==> $*${RESET}"; }

# ── Config (override via env) ─────────────────────────────────────────────────
ZVELTIO_PORT="${ZVELTIO_PORT:-3000}"
ZVELTIO_VERSION="${ZVELTIO_VERSION:-latest}"
ZVELTIO_DIR="${ZVELTIO_DIR:-/opt/zveltio}"
ZVELTIO_USER="${ZVELTIO_USER:-zveltio}"
INSTALL_MODE="${INSTALL_MODE:-auto}"   # auto | docker | native

# ── Guards ────────────────────────────────────────────────────────────────────
header "Zveltio — Installer"

if [[ $EUID -ne 0 ]]; then
  error "Run as root: sudo bash install/install.sh"
  exit 1
fi

# Detect OS
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_VERSION="${VERSION_ID:-}"
else
  error "Cannot detect OS. Supported: Ubuntu 22+, Debian 11/12."
  exit 1
fi

case "$OS_ID" in
  ubuntu|debian) ;;
  *)
    error "Unsupported OS: ${OS_ID}. Supported: Ubuntu 22+, Debian 11/12."
    exit 1
    ;;
esac

info "Detected OS: ${OS_ID} ${OS_VERSION}"

# ── Auto-detect mode ──────────────────────────────────────────────────────────
if [[ "$INSTALL_MODE" == "auto" ]]; then
  if command -v bun &>/dev/null; then
    # Bun already present — use native (lower overhead, better for production)
    INSTALL_MODE="native"
    info "Bun detected — using native mode"
  elif command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    # Docker present but no Bun — respect the user's existing setup
    INSTALL_MODE="docker"
    info "Docker detected (no Bun) — using Docker mode"
  else
    # Fresh server: install Bun and go native (less RAM, better systemd integration)
    INSTALL_MODE="native"
    info "No runtime detected — will install Bun (native mode)"
  fi
fi

info "Install mode: ${BOLD}${INSTALL_MODE}${RESET}"

# ── Generate secrets ──────────────────────────────────────────────────────────
gen_secret() { openssl rand -hex 32; }

POSTGRES_PASSWORD=$(gen_secret)
VALKEY_PASSWORD=$(gen_secret)
BETTER_AUTH_SECRET=$(gen_secret)
MAIL_ENCRYPTION_KEY=$(gen_secret)
AI_KEY_ENCRYPTION_KEY=$(gen_secret)
S3_ACCESS_KEY=$(gen_secret | cut -c1-20)
S3_SECRET_KEY=$(gen_secret)

# ── System dependencies (common) ──────────────────────────────────────────────
header "Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl wget gnupg2 lsb-release ca-certificates \
  apt-transport-https software-properties-common unzip git openssl
success "System dependencies ready"

# ── RAM detection (used by both modes for tuning) ─────────────────────────────
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
# PostgreSQL: 12.5% RAM for shared_buffers, 37.5% for effective_cache
PG_SHARED_BUFFERS=$(( TOTAL_RAM_MB / 8 ))
PG_EFFECTIVE_CACHE=$(( TOTAL_RAM_MB * 3 / 8 ))
# Cap at sane maximums
(( PG_SHARED_BUFFERS > 2048 )) && PG_SHARED_BUFFERS=2048
(( PG_EFFECTIVE_CACHE > 6144 )) && PG_EFFECTIVE_CACHE=6144

info "RAM: ${TOTAL_RAM_MB}MB → PostgreSQL shared_buffers=${PG_SHARED_BUFFERS}MB, effective_cache=${PG_EFFECTIVE_CACHE}MB"

# =============================================================================
# DOCKER MODE
# =============================================================================
install_docker_mode() {
  # ── Install Docker if missing ─────────────────────────────────────────────
  if ! command -v docker &>/dev/null; then
    header "Installing Docker"
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    success "Docker installed: $(docker --version)"
  else
    info "Docker already installed: $(docker --version)"
  fi

  # Verify docker compose plugin
  if ! docker compose version &>/dev/null 2>&1; then
    error "Docker Compose plugin not found. Install it: https://docs.docker.com/compose/install/"
    exit 1
  fi

  # ── Prepare install directory ─────────────────────────────────────────────
  header "Preparing ${ZVELTIO_DIR}"
  mkdir -p "${ZVELTIO_DIR}"

  # ── Download docker-compose.yml ───────────────────────────────────────────
  local COMPOSE_URL
  if [[ "$ZVELTIO_VERSION" == "latest" || "$ZVELTIO_VERSION" == "main" ]]; then
    COMPOSE_URL="https://raw.githubusercontent.com/zveltio/zveltio/main/docker-compose.yml"
  else
    COMPOSE_URL="https://raw.githubusercontent.com/zveltio/zveltio/${ZVELTIO_VERSION}/docker-compose.yml"
  fi

  info "Downloading docker-compose.yml from ${COMPOSE_URL}"
  if ! curl -fsSL "$COMPOSE_URL" -o "${ZVELTIO_DIR}/docker-compose.yml"; then
    error "Failed to download docker-compose.yml. Check your internet connection."
    exit 1
  fi
  success "docker-compose.yml downloaded"

  # ── Write .env ────────────────────────────────────────────────────────────
  header "Writing configuration"

  cat > "${ZVELTIO_DIR}/.env" << EOF
PORT=${ZVELTIO_PORT}
NODE_ENV=production

# PostgreSQL
POSTGRES_USER=${ZVELTIO_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${ZVELTIO_USER}

# PostgreSQL tuning (auto-calculated from available RAM: ${TOTAL_RAM_MB}MB)
POSTGRES_SHARED_BUFFERS=${PG_SHARED_BUFFERS}MB
POSTGRES_EFFECTIVE_CACHE=${PG_EFFECTIVE_CACHE}MB

# Auth
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
BETTER_AUTH_URL=http://localhost:${ZVELTIO_PORT}

# Cache
VALKEY_PASSWORD=${VALKEY_PASSWORD}

# Storage (SeaweedFS)
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_PUBLIC_URL=http://localhost:8333

# Encryption keys
MAIL_ENCRYPTION_KEY=${MAIL_ENCRYPTION_KEY}
AI_KEY_ENCRYPTION_KEY=${AI_KEY_ENCRYPTION_KEY}

# Grafana
GRAFANA_ADMIN_PASSWORD=$(gen_secret | cut -c1-24)

# Extensions (comma-separated)
ZVELTIO_EXTENSIONS=
EOF

  chmod 600 "${ZVELTIO_DIR}/.env"
  success "Configuration written to ${ZVELTIO_DIR}/.env"

  # ── Copy helper scripts ───────────────────────────────────────────────────
  local SCRIPTS_BASE="https://raw.githubusercontent.com/zveltio/zveltio/main/install"
  for script in update.sh uninstall.sh; do
    curl -fsSL "${SCRIPTS_BASE}/${script}" -o "${ZVELTIO_DIR}/${script}" 2>/dev/null || \
      cp "$(dirname "$0")/${script}" "${ZVELTIO_DIR}/${script}" 2>/dev/null || true
    chmod +x "${ZVELTIO_DIR}/${script}" 2>/dev/null || true
  done

  # ── Start services ────────────────────────────────────────────────────────
  header "Starting Zveltio (Docker)"
  cd "${ZVELTIO_DIR}"
  docker compose up -d
  success "Containers started"

  # ── Wait for engine to be healthy ─────────────────────────────────────────
  header "Waiting for engine to be ready"
  local ATTEMPTS=0
  local MAX_ATTEMPTS=60
  until curl -sf "http://localhost:${ZVELTIO_PORT}/health" >/dev/null 2>&1; do
    ATTEMPTS=$(( ATTEMPTS + 1 ))
    if (( ATTEMPTS >= MAX_ATTEMPTS )); then
      error "Engine did not start within ${MAX_ATTEMPTS}s."
      error "Check logs: docker compose -f ${ZVELTIO_DIR}/docker-compose.yml logs engine"
      exit 1
    fi
    printf '.'
    sleep 2
  done
  echo ""
  success "Engine is healthy"

  # ── Run migrations ────────────────────────────────────────────────────────
  header "Running database migrations"
  docker compose exec -T engine zveltio migrate
  success "Migrations complete"

  # ── Create God user ───────────────────────────────────────────────────────
  header "Creating admin account"
  echo -n "  Email: "
  read -r GOD_EMAIL </dev/tty
  while true; do
    echo -n "  Password: "
    read -rs GOD_PASSWORD </dev/tty
    echo ""
    echo -n "  Confirm password: "
    read -rs GOD_PASSWORD_CONFIRM </dev/tty
    echo ""
    if [[ "$GOD_PASSWORD" == "$GOD_PASSWORD_CONFIRM" ]]; then
      break
    fi
    warn "Passwords do not match. Please try again."
  done
  docker compose exec -T engine zveltio create-god \
    --email "$GOD_EMAIL" --password "$GOD_PASSWORD"
  success "Admin account created"

  # ── Firewall ──────────────────────────────────────────────────────────────
  if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow "${ZVELTIO_PORT}/tcp" comment "Zveltio" &>/dev/null || true
    success "Firewall rule added for port ${ZVELTIO_PORT}"
  fi

  # ── Summary ───────────────────────────────────────────────────────────────
  local SERVER_IP
  SERVER_IP=$(hostname -I | awk '{print $1}')

  header "Installation complete! (Docker mode)"
  echo ""
  echo -e "${BOLD}Admin email:${RESET}     ${GOD_EMAIL}"
  echo -e "${BOLD}Zveltio Studio:${RESET}  http://${SERVER_IP}:${ZVELTIO_PORT}/admin"
  echo -e "${BOLD}API:${RESET}             http://${SERVER_IP}:${ZVELTIO_PORT}/api"
  echo ""
  echo -e "  All credentials are stored in: ${BOLD}${ZVELTIO_DIR}/.env${RESET}"
  echo -e "  ${YELLOW}Review with: cat ${ZVELTIO_DIR}/.env${RESET}"
  echo ""
  echo -e "${BOLD}Useful commands:${RESET}"
  echo -e "  View logs:    docker compose -f ${ZVELTIO_DIR}/docker-compose.yml logs -f engine"
  echo -e "  Restart:      docker compose -f ${ZVELTIO_DIR}/docker-compose.yml restart engine"
  echo -e "  Update:       bash ${ZVELTIO_DIR}/update.sh"
  echo -e "  Status:       docker compose -f ${ZVELTIO_DIR}/docker-compose.yml ps"
  echo ""
}

# =============================================================================
# NATIVE MODE (Bun + systemd)
# =============================================================================
install_native_mode() {
  # Check if already installed
  if systemctl is-active --quiet zveltio 2>/dev/null; then
    warn "Zveltio is already running. Use 'bash ${ZVELTIO_DIR}/update.sh' to update."
    exit 0
  fi

  apt-get install -y -qq build-essential

  # ── PostgreSQL 18 + pgvector ────────────────────────────────────────────────
  header "Installing PostgreSQL 18 + pgvector"

  if ! command -v psql &>/dev/null; then
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL 'https://www.postgresql.org/media/keys/ACCC4CF8.asc' \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] \
      https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y -qq postgresql-18 postgresql-18-pgvector
    systemctl enable postgresql
    systemctl start postgresql
    success "PostgreSQL 18 installed"
  else
    info "PostgreSQL already installed: $(psql --version)"
  fi

  # Validate credentials contain only safe characters (hex from gen_secret, or
  # alphanumeric if user-supplied) to prevent SQL injection via env overrides.
  if [[ ! "$POSTGRES_PASSWORD" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    error "POSTGRES_PASSWORD contains unsafe characters. Use only alphanumeric, dot, dash, underscore."
    exit 1
  fi
  if [[ ! "$ZVELTIO_USER" =~ ^[a-z][a-z0-9_]*$ ]]; then
    error "ZVELTIO_USER must start with a letter and contain only lowercase letters, digits, underscores."
    exit 1
  fi

  su -c "psql -c \"CREATE USER ${ZVELTIO_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';\"" postgres 2>/dev/null || \
    su -c "psql -c \"ALTER USER ${ZVELTIO_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';\"" postgres
  su -c "psql -c \"CREATE DATABASE ${ZVELTIO_USER} OWNER ${ZVELTIO_USER};\"" postgres 2>/dev/null || true
  su -c "psql -d ${ZVELTIO_USER} -c 'CREATE EXTENSION IF NOT EXISTS vector;'" postgres
  su -c "psql -d ${ZVELTIO_USER} -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'" postgres

  cat > /etc/postgresql/18/main/conf.d/zveltio.conf << EOF
shared_buffers = ${PG_SHARED_BUFFERS}MB
effective_cache_size = ${PG_EFFECTIVE_CACHE}MB
maintenance_work_mem = 64MB
work_mem = 4MB
max_connections = 200
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
checkpoint_completion_target = 0.9
random_page_cost = 1.1
EOF

  systemctl restart postgresql
  success "PostgreSQL configured (shared_buffers=${PG_SHARED_BUFFERS}MB)"

  # ── Valkey ──────────────────────────────────────────────────────────────────
  header "Installing Valkey"

  if ! command -v valkey-server &>/dev/null; then
    local VALKEY_VER="8.0.2"
    local ARCH
    ARCH=$(dpkg --print-architecture)
    local VALKEY_INSTALLED=false

    # Try pre-built binary first (fastest)
    if [[ "$ARCH" == "amd64" || "$ARCH" == "arm64" ]]; then
      # Valkey release naming: valkey-<ver>-<distro>-<arch>.tar.gz
      local DISTRO_CODENAME
      DISTRO_CODENAME=$(lsb_release -cs 2>/dev/null || echo "")
      local VALKEY_ARCH="$ARCH"

      # Try distro-specific binary first, then generic Ubuntu/Debian variants
      local URLS=()
      if [[ -n "$DISTRO_CODENAME" ]]; then
        URLS+=("https://github.com/valkey-io/valkey/releases/download/${VALKEY_VER}/valkey-${VALKEY_VER}-${DISTRO_CODENAME}-${VALKEY_ARCH}.tar.gz")
      fi
      URLS+=("https://github.com/valkey-io/valkey/releases/download/${VALKEY_VER}/valkey-${VALKEY_VER}-noble-${VALKEY_ARCH}.tar.gz")
      URLS+=("https://github.com/valkey-io/valkey/releases/download/${VALKEY_VER}/valkey-${VALKEY_VER}-bookworm-${VALKEY_ARCH}.tar.gz")
      URLS+=("https://github.com/valkey-io/valkey/releases/download/${VALKEY_VER}/valkey-${VALKEY_VER}-jammy-${VALKEY_ARCH}.tar.gz")

      for url in "${URLS[@]}"; do
        info "Trying ${url##*/}..."
        if wget -q "$url" -O /tmp/valkey.tar.gz 2>/dev/null; then
          # Find the extracted directory name dynamically
          local VALKEY_DIR
          VALKEY_DIR=$(tar -tzf /tmp/valkey.tar.gz 2>/dev/null | head -1 | cut -d/ -f1)
          tar -xzf /tmp/valkey.tar.gz -C /tmp
          if [[ -f "/tmp/${VALKEY_DIR}/bin/valkey-server" ]]; then
            mv "/tmp/${VALKEY_DIR}/bin/valkey-server" /usr/local/bin/
            mv "/tmp/${VALKEY_DIR}/bin/valkey-cli" /usr/local/bin/
            VALKEY_INSTALLED=true
          elif [[ -f "/tmp/${VALKEY_DIR}/valkey-server" ]]; then
            mv "/tmp/${VALKEY_DIR}/valkey-server" /usr/local/bin/
            mv "/tmp/${VALKEY_DIR}/valkey-cli" /usr/local/bin/
            VALKEY_INSTALLED=true
          fi
          rm -rf /tmp/valkey* "/tmp/${VALKEY_DIR}"
          if [[ "$VALKEY_INSTALLED" == "true" ]]; then
            success "Valkey ${VALKEY_VER} binary installed"
            break
          fi
        fi
      done
    fi

    # Fallback: build from source
    if [[ "$VALKEY_INSTALLED" == "false" ]]; then
      warn "Pre-built binary not available — building Valkey from source (this takes a few minutes)..."
      apt-get install -y -qq build-essential
      wget -q "https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VER}.tar.gz" -O /tmp/valkey-src.tar.gz
      tar -xzf /tmp/valkey-src.tar.gz -C /tmp
      make -C "/tmp/valkey-${VALKEY_VER}" -j"$(nproc)" install
      rm -rf /tmp/valkey-src.tar.gz "/tmp/valkey-${VALKEY_VER}"
      success "Valkey ${VALKEY_VER} built and installed from source"
    fi
  else
    info "Valkey already installed"
  fi

  local VALKEY_MAX_MEM=$(( TOTAL_RAM_MB / 4 ))
  (( VALKEY_MAX_MEM > 1024 )) && VALKEY_MAX_MEM=1024

  id -u valkey &>/dev/null || useradd -r -s /bin/false valkey
  mkdir -p /var/lib/valkey /var/log/valkey /etc/valkey
  chown valkey:valkey /var/lib/valkey /var/log/valkey

  cat > /etc/valkey/valkey.conf << EOF
bind 127.0.0.1
port 6379
requirepass ${VALKEY_PASSWORD}
appendonly yes
appendfsync everysec
dir /var/lib/valkey
logfile /var/log/valkey/valkey.log
maxmemory ${VALKEY_MAX_MEM}mb
maxmemory-policy allkeys-lru
EOF

  cat > /etc/systemd/system/valkey.service << 'UNIT'
[Unit]
Description=Valkey In-Memory Data Store
After=network.target

[Service]
User=valkey
Group=valkey
ExecStart=/usr/local/bin/valkey-server /etc/valkey/valkey.conf
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable valkey
  systemctl start valkey
  success "Valkey running (maxmemory=${VALKEY_MAX_MEM}MB)"

  # ── SeaweedFS ────────────────────────────────────────────────────────────────
  header "Installing SeaweedFS"

  if ! command -v weed &>/dev/null; then
    local SWFS_VER="3.68"
    local SWFS_ARCH
    SWFS_ARCH=$(uname -m)
    local SWFS_FILE
    case "$SWFS_ARCH" in
      x86_64)  SWFS_FILE="linux_amd64.tar.gz" ;;
      aarch64) SWFS_FILE="linux_arm64.tar.gz" ;;
      *)
        error "Unsupported architecture for SeaweedFS: ${SWFS_ARCH}"
        exit 1
        ;;
    esac

    if ! wget -q "https://github.com/seaweedfs/seaweedfs/releases/download/${SWFS_VER}/${SWFS_FILE}" \
      -O /tmp/seaweedfs.tar.gz; then
      error "Failed to download SeaweedFS ${SWFS_VER}. Check your internet connection or try a different version."
      exit 1
    fi
    tar -xzf /tmp/seaweedfs.tar.gz -C /usr/local/bin weed
    chmod +x /usr/local/bin/weed
    rm /tmp/seaweedfs.tar.gz
    success "SeaweedFS installed"
  else
    info "SeaweedFS already installed"
  fi

  id -u seaweedfs &>/dev/null || useradd -r -s /bin/false seaweedfs
  mkdir -p /var/lib/seaweedfs/{master,volume,filer}
  chown -R seaweedfs:seaweedfs /var/lib/seaweedfs

  cat > /etc/systemd/system/seaweedfs.service << 'UNIT'
[Unit]
Description=SeaweedFS Object Storage
After=network.target

[Service]
User=seaweedfs
ExecStart=/usr/local/bin/weed server -s3 -filer \
  -dir=/var/lib/seaweedfs/master \
  -volume.dir=/var/lib/seaweedfs/volume \
  -filer.dir=/var/lib/seaweedfs/filer \
  -ip=127.0.0.1 \
  -s3.port=8333 \
  -filer.port=8888
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable seaweedfs
  systemctl start seaweedfs
  success "SeaweedFS running"

  # ── Bun ──────────────────────────────────────────────────────────────────────
  header "Installing Bun"

  if ! command -v bun &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
    success "Bun installed: $(bun --version)"
  else
    info "Bun already installed: $(bun --version)"
  fi

  # ── Zveltio binary ───────────────────────────────────────────────────────────
  header "Installing Zveltio ${ZVELTIO_VERSION}"

  mkdir -p "${ZVELTIO_DIR}"

  local RESOLVED_VERSION="$ZVELTIO_VERSION"
  if [[ "$RESOLVED_VERSION" == "latest" ]]; then
    # /releases/latest only returns stable releases — use /releases to catch
    # pre-release versions (alpha/beta/rc) when no stable exists yet.
    RESOLVED_VERSION=$(curl -fsSL \
      "https://api.github.com/repos/zveltio-devs/zveltio/releases" \
      | grep '"tag_name"' | head -1 | cut -d'"' -f4 || echo "")
  fi

  if [[ -z "$RESOLVED_VERSION" ]]; then
    error "Could not determine Zveltio version. Check your internet connection."
    exit 1
  fi

  info "Installing version: ${RESOLVED_VERSION}"

  local BINARY_INSTALLED=false
  local ARCH_SLUG
  ARCH_SLUG=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')

  # Check AVX2 support via cpuinfo — more reliable than testing the binary,
  # which can fail for unrelated reasons (permissions, missing libs, etc.)
  local USE_BASELINE=false
  if [[ "$ARCH_SLUG" == "x64" ]] && ! grep -q 'avx2' /proc/cpuinfo 2>/dev/null; then
    USE_BASELINE=true
    warn "CPU does not support AVX2 — will use baseline binary"
  fi

  local BINARY_NAME="zveltio-linux-${ARCH_SLUG}"
  [[ "$USE_BASELINE" == "true" ]] && BINARY_NAME="zveltio-linux-${ARCH_SLUG}-baseline"

  local BINARY_URL="https://github.com/zveltio-devs/zveltio/releases/download/${RESOLVED_VERSION}/${BINARY_NAME}"
  info "Downloading binary from ${BINARY_URL}"
  if curl -fsSL --head "$BINARY_URL" &>/dev/null; then
    wget -q "$BINARY_URL" -O "${ZVELTIO_DIR}/zveltio"
    chmod +x "${ZVELTIO_DIR}/zveltio"
    BINARY_INSTALLED=true
    success "Downloaded binary ${RESOLVED_VERSION} (${BINARY_NAME})"
  fi

  if [[ "$BINARY_INSTALLED" == "false" ]]; then
    error "No pre-built binary found for ${RESOLVED_VERSION} (${BINARY_NAME})."
    error "This is an alpha release — compiled binaries may not yet be available."
    error "Check releases at: https://github.com/zveltio-devs/zveltio/releases"
    exit 1
  fi

  # ── .env ─────────────────────────────────────────────────────────────────────
  header "Writing configuration"

  cat > "${ZVELTIO_DIR}/.env" << EOF
PORT=${ZVELTIO_PORT}
HOST=0.0.0.0
NODE_ENV=production

DATABASE_URL=postgresql://${ZVELTIO_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${ZVELTIO_USER}
NATIVE_DATABASE_URL=postgresql://${ZVELTIO_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${ZVELTIO_USER}

BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
BETTER_AUTH_URL=http://localhost:${ZVELTIO_PORT}

VALKEY_URL=redis://:${VALKEY_PASSWORD}@127.0.0.1:6379

S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_BUCKET=zveltio
S3_PUBLIC_URL=http://localhost:8333

MAIL_ENCRYPTION_KEY=${MAIL_ENCRYPTION_KEY}
AI_KEY_ENCRYPTION_KEY=${AI_KEY_ENCRYPTION_KEY}

ZVELTIO_EXTENSIONS=
EOF

  chmod 600 "${ZVELTIO_DIR}/.env"

  # ── Copy helper scripts ───────────────────────────────────────────────────────
  local SCRIPTS_BASE="https://raw.githubusercontent.com/zveltio/zveltio/main/install"
  for script in update.sh uninstall.sh; do
    curl -fsSL "${SCRIPTS_BASE}/${script}" -o "${ZVELTIO_DIR}/${script}" 2>/dev/null || \
      cp "$(dirname "$0")/${script}" "${ZVELTIO_DIR}/${script}" 2>/dev/null || true
    chmod +x "${ZVELTIO_DIR}/${script}" 2>/dev/null || true
  done

  # ── systemd service ───────────────────────────────────────────────────────────
  id -u "${ZVELTIO_USER}" &>/dev/null || \
    useradd -r -s /bin/false -d "${ZVELTIO_DIR}" "${ZVELTIO_USER}"
  chown -R "${ZVELTIO_USER}:${ZVELTIO_USER}" "${ZVELTIO_DIR}"

  local EXEC_START
  if [[ -f "${ZVELTIO_DIR}/zveltio" ]]; then
    EXEC_START="${ZVELTIO_DIR}/zveltio start"
  else
    EXEC_START="/usr/local/bin/bun ${ZVELTIO_DIR}/index.js"
  fi

  cat > /etc/systemd/system/zveltio.service << EOF
[Unit]
Description=Zveltio BaaS Engine
After=network.target postgresql.service valkey.service seaweedfs.service
Wants=postgresql.service valkey.service seaweedfs.service

[Service]
User=${ZVELTIO_USER}
WorkingDirectory=${ZVELTIO_DIR}
EnvironmentFile=${ZVELTIO_DIR}/.env
ExecStart=${EXEC_START}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zveltio

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${ZVELTIO_DIR}
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable zveltio

  # ── Run migrations + create god user ─────────────────────────────────────────
  header "Running database migrations"
  if [[ -f "${ZVELTIO_DIR}/zveltio" ]]; then
    sudo -u "${ZVELTIO_USER}" bash -c "cd ${ZVELTIO_DIR} && env \$(cat .env | xargs) ./zveltio migrate"
  else
    sudo -u "${ZVELTIO_USER}" bash -c "cd ${ZVELTIO_DIR} && env \$(cat .env | xargs) bun index.js migrate"
  fi
  success "Migrations complete"

  header "Creating admin account"
  echo -n "  Email: "
  read -r GOD_EMAIL </dev/tty
  while true; do
    echo -n "  Password: "
    read -rs GOD_PASSWORD </dev/tty
    echo ""
    echo -n "  Confirm password: "
    read -rs GOD_PASSWORD_CONFIRM </dev/tty
    echo ""
    if [[ "$GOD_PASSWORD" == "$GOD_PASSWORD_CONFIRM" ]]; then
      break
    fi
    warn "Passwords do not match. Please try again."
  done
  # Pass credentials via environment variables to avoid shell injection
  if [[ -f "${ZVELTIO_DIR}/zveltio" ]]; then
    sudo -u "${ZVELTIO_USER}" \
      GOD_EMAIL="$GOD_EMAIL" GOD_PASSWORD="$GOD_PASSWORD" \
      bash -c 'cd '"${ZVELTIO_DIR}"' && env $(cat .env | xargs) ./zveltio create-god --email "$GOD_EMAIL" --password "$GOD_PASSWORD"'
  else
    sudo -u "${ZVELTIO_USER}" \
      GOD_EMAIL="$GOD_EMAIL" GOD_PASSWORD="$GOD_PASSWORD" \
      bash -c 'cd '"${ZVELTIO_DIR}"' && env $(cat .env | xargs) bun index.js create-god --email "$GOD_EMAIL" --password "$GOD_PASSWORD"'
  fi

  systemctl start zveltio

  # ── Firewall ──────────────────────────────────────────────────────────────────
  if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow "${ZVELTIO_PORT}/tcp" comment "Zveltio" &>/dev/null || true
    success "Firewall rule added for port ${ZVELTIO_PORT}"
  fi

  # ── Summary ───────────────────────────────────────────────────────────────────
  local SERVER_IP
  SERVER_IP=$(hostname -I | awk '{print $1}')

  header "Installation complete! (native mode)"
  echo ""
  echo -e "${BOLD}Admin email:${RESET}     ${GOD_EMAIL}"
  echo -e "${BOLD}Zveltio Studio:${RESET}  http://${SERVER_IP}:${ZVELTIO_PORT}/admin"
  echo -e "${BOLD}API:${RESET}             http://${SERVER_IP}:${ZVELTIO_PORT}/api"
  echo ""
  echo -e "  All credentials are stored in: ${BOLD}${ZVELTIO_DIR}/.env${RESET}"
  echo -e "  ${YELLOW}Review with: cat ${ZVELTIO_DIR}/.env${RESET}"
  echo ""
  echo -e "${BOLD}Useful commands:${RESET}"
  echo -e "  View logs:    journalctl -u zveltio -f"
  echo -e "  Restart:      systemctl restart zveltio"
  echo -e "  Update:       bash ${ZVELTIO_DIR}/update.sh"
  echo -e "  Status:       systemctl status zveltio"
  echo ""
}

# =============================================================================
# DISPATCH
# =============================================================================
case "$INSTALL_MODE" in
  docker) install_docker_mode ;;
  native) install_native_mode ;;
  *)
    error "Unknown INSTALL_MODE: ${INSTALL_MODE}. Use 'docker' or 'native'."
    exit 1
    ;;
esac
