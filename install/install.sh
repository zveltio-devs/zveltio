#!/usr/bin/env bash
# =============================================================================
# Zveltio — One-command VPS / Bare-metal Installer
# =============================================================================
# Installs Zveltio directly on a Linux server (Ubuntu 22+, Debian 11/12).
# Installs: Bun, PostgreSQL 16, Valkey, SeaweedFS, Zveltio engine.
# All services managed via systemd with auto-start on boot.
#
# Usage:
#   curl -fsSL https://get.zveltio.com | bash
#
# Or with options:
#   ZVELTIO_PORT=4000 ZVELTIO_VERSION=v2.0.0 bash install/install.sh
#
# Supported OS: Ubuntu 22.04+, Debian 11/12
# Minimum specs: 1 vCPU, 1GB RAM, 10GB disk
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
ZVELTIO_PORT="${ZVELTIO_PORT:-4000}"
ZVELTIO_VERSION="${ZVELTIO_VERSION:-latest}"
ZVELTIO_DIR="${ZVELTIO_DIR:-/opt/zveltio}"
ZVELTIO_USER="${ZVELTIO_USER:-zveltio}"

# ── Guards ────────────────────────────────────────────────────────────────────
header "Zveltio — Server Installer"

if [[ $EUID -ne 0 ]]; then
  error "Run as root: sudo bash install/install.sh"
  exit 1
fi

# Detect OS
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS_ID="$ID"
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

# Check if already installed
if systemctl is-active --quiet zveltio 2>/dev/null; then
  warn "Zveltio is already running. Use 'bash ${ZVELTIO_DIR}/update.sh' to update."
  exit 0
fi

# ── Generate secrets ──────────────────────────────────────────────────────────
gen_secret() { openssl rand -hex 32; }

POSTGRES_PASSWORD=$(gen_secret)
VALKEY_PASSWORD=$(gen_secret)
BETTER_AUTH_SECRET=$(gen_secret)
MAIL_ENCRYPTION_KEY=$(gen_secret)
AI_KEY_ENCRYPTION_KEY=$(gen_secret)
S3_ACCESS_KEY=$(gen_secret | cut -c1-20)
S3_SECRET_KEY=$(gen_secret)

# ── System dependencies ───────────────────────────────────────────────────────
header "Installing system dependencies"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl wget gnupg2 lsb-release ca-certificates \
  apt-transport-https software-properties-common \
  unzip git openssl build-essential

success "System dependencies installed"

# ── PostgreSQL 16 + pgvector ──────────────────────────────────────────────────
header "Installing PostgreSQL 16 + pgvector"

if ! command -v psql &>/dev/null; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL 'https://www.postgresql.org/media/keys/ACCC4CF8.asc' \
    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] \
    https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-16 postgresql-16-pgvector
  systemctl enable postgresql
  systemctl start postgresql
  success "PostgreSQL installed"
else
  info "PostgreSQL already installed"
fi

# Create database and user
su -c "psql -c \"CREATE USER ${ZVELTIO_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';\"" postgres 2>/dev/null || \
  su -c "psql -c \"ALTER USER ${ZVELTIO_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';\"" postgres
su -c "psql -c \"CREATE DATABASE ${ZVELTIO_USER} OWNER ${ZVELTIO_USER};\"" postgres 2>/dev/null || true
su -c "psql -d ${ZVELTIO_USER} -c 'CREATE EXTENSION IF NOT EXISTS vector;'" postgres
su -c "psql -d ${ZVELTIO_USER} -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'" postgres

# Performance tuning
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
SHARED_BUFFERS=$(( TOTAL_RAM_MB / 4 ))MB
EFFECTIVE_CACHE=$(( TOTAL_RAM_MB * 3 / 4 ))MB

cat > /etc/postgresql/16/main/conf.d/zveltio.conf << EOF
shared_buffers = ${SHARED_BUFFERS}
effective_cache_size = ${EFFECTIVE_CACHE}
maintenance_work_mem = 64MB
work_mem = 8MB
max_connections = 200
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
checkpoint_completion_target = 0.9
random_page_cost = 1.1
EOF

systemctl restart postgresql
success "PostgreSQL configured"

# ── Valkey ────────────────────────────────────────────────────────────────────
header "Installing Valkey"

if ! command -v valkey-server &>/dev/null; then
  VALKEY_VER="8.0.1"
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    amd64)  VALKEY_ARCH="linux_amd64" ;;
    arm64)  VALKEY_ARCH="linux_arm64" ;;
    *)
      warn "Valkey binary not available for ${ARCH}, building from source..."
      apt-get install -y -qq build-essential
      wget -q "https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VER}.tar.gz" -O /tmp/valkey-src.tar.gz
      tar -xzf /tmp/valkey-src.tar.gz -C /tmp
      make -C "/tmp/valkey-${VALKEY_VER}" -j"$(nproc)" install
      rm -rf /tmp/valkey-src.tar.gz "/tmp/valkey-${VALKEY_VER}"
      VALKEY_ARCH=""
      ;;
  esac

  if [[ -n "$VALKEY_ARCH" ]]; then
    wget -q "https://github.com/valkey-io/valkey/releases/download/${VALKEY_VER}/valkey-${VALKEY_VER}-${VALKEY_ARCH}-debian-bookworm.tar.gz" \
      -O /tmp/valkey.tar.gz
    tar -xzf /tmp/valkey.tar.gz -C /tmp
    mv "/tmp/valkey-${VALKEY_VER}-${VALKEY_ARCH}-debian-bookworm/bin/valkey-server" /usr/local/bin/
    mv "/tmp/valkey-${VALKEY_VER}-${VALKEY_ARCH}-debian-bookworm/bin/valkey-cli" /usr/local/bin/
    rm -rf /tmp/valkey*
  fi

  success "Valkey installed"
else
  info "Valkey already installed"
fi

id -u valkey &>/dev/null || useradd -r -s /bin/false valkey
mkdir -p /var/lib/valkey /var/log/valkey /etc/valkey
chown valkey:valkey /var/lib/valkey /var/log/valkey

# Calculate Valkey max memory (25% of RAM, max 1GB)
VALKEY_MAX_MEM=$(( TOTAL_RAM_MB / 4 ))
if (( VALKEY_MAX_MEM > 1024 )); then VALKEY_MAX_MEM=1024; fi

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
success "Valkey running"

# ── SeaweedFS ─────────────────────────────────────────────────────────────────
header "Installing SeaweedFS"

if ! command -v weed &>/dev/null; then
  SWFS_VER="3.68"
  SWFS_ARCH=$(uname -m)
  case "$SWFS_ARCH" in
    x86_64)  SWFS_FILE="linux_amd64.tar.gz" ;;
    aarch64) SWFS_FILE="linux_arm64.tar.gz" ;;
    *)
      error "Unsupported architecture for SeaweedFS: ${SWFS_ARCH}"
      exit 1
      ;;
  esac

  wget -q "https://github.com/seaweedfs/seaweedfs/releases/download/${SWFS_VER}/${SWFS_FILE}" \
    -O /tmp/seaweedfs.tar.gz
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

# ── Bun ───────────────────────────────────────────────────────────────────────
header "Installing Bun"

if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
  success "Bun installed: $(bun --version)"
else
  info "Bun already installed: $(bun --version)"
fi

# ── Zveltio ───────────────────────────────────────────────────────────────────
header "Installing Zveltio ${ZVELTIO_VERSION}"

mkdir -p "${ZVELTIO_DIR}/engine"

if [[ "$ZVELTIO_VERSION" == "latest" ]]; then
  ZVELTIO_VERSION=$(curl -fsSL https://api.github.com/repos/zveltio/zveltio/releases/latest \
    | grep '"tag_name"' | cut -d'"' -f4 || echo "main")
fi

if [[ "$ZVELTIO_VERSION" == "main" ]] || [[ -z "$ZVELTIO_VERSION" ]]; then
  warn "No release found — installing from source (main branch)"
  git clone --depth=1 https://github.com/zveltio/zveltio.git /tmp/zveltio-src
  cd /tmp/zveltio-src
  BUN_MEMORY_LIMIT=2048 bun install --frozen-lockfile
  cd packages/engine && BUN_MEMORY_LIMIT=2048 bun run build:prod
  cp -r dist/. "${ZVELTIO_DIR}/engine/"
  cp -r ../../extensions "${ZVELTIO_DIR}/" 2>/dev/null || true
  rm -rf /tmp/zveltio-src
  cd "${ZVELTIO_DIR}"
else
  # Try pre-built binary first
  BINARY_URL="https://github.com/zveltio/zveltio/releases/download/${ZVELTIO_VERSION}/zveltio-linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
  if curl -fsSL --head "$BINARY_URL" &>/dev/null; then
    wget -q "$BINARY_URL" -O "${ZVELTIO_DIR}/zveltio"
    chmod +x "${ZVELTIO_DIR}/zveltio"
    info "Downloaded pre-built binary"
  else
    # Fall back to source install
    warn "No binary for this architecture — building from source"
    git clone --depth=1 --branch "$ZVELTIO_VERSION" \
      https://github.com/zveltio/zveltio.git /tmp/zveltio-src
    cd /tmp/zveltio-src
    BUN_MEMORY_LIMIT=2048 bun install --frozen-lockfile
    cd packages/engine && BUN_MEMORY_LIMIT=2048 bun run build:prod
    cp -r dist/. "${ZVELTIO_DIR}/engine/"
    cp -r ../../extensions "${ZVELTIO_DIR}/" 2>/dev/null || true
    rm -rf /tmp/zveltio-src
    cd "${ZVELTIO_DIR}"
  fi
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

# Download update/uninstall scripts into install dir
SCRIPTS_BASE="https://raw.githubusercontent.com/zveltio/zveltio/main/install"
for script in update.sh uninstall.sh; do
  curl -fsSL "${SCRIPTS_BASE}/${script}" -o "${ZVELTIO_DIR}/${script}" 2>/dev/null || \
    cp "$(dirname "$0")/${script}" "${ZVELTIO_DIR}/${script}" 2>/dev/null || true
  chmod +x "${ZVELTIO_DIR}/${script}" 2>/dev/null || true
done

# ── systemd user + service ────────────────────────────────────────────────────
id -u "${ZVELTIO_USER}" &>/dev/null || \
  useradd -r -s /bin/false -d "${ZVELTIO_DIR}" "${ZVELTIO_USER}"
chown -R "${ZVELTIO_USER}:${ZVELTIO_USER}" "${ZVELTIO_DIR}"

cat > /etc/systemd/system/zveltio.service << EOF
[Unit]
Description=Zveltio BaaS Engine
After=network.target postgresql.service valkey.service seaweedfs.service
Wants=postgresql.service valkey.service seaweedfs.service

[Service]
User=${ZVELTIO_USER}
WorkingDirectory=${ZVELTIO_DIR}
EnvironmentFile=${ZVELTIO_DIR}/.env
ExecStart=/usr/local/bin/bun ${ZVELTIO_DIR}/engine/index.js
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
systemctl start zveltio

# ── Firewall (ufw if present) ─────────────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "${ZVELTIO_PORT}/tcp" comment "Zveltio" &>/dev/null || true
  success "Firewall rule added for port ${ZVELTIO_PORT}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')

header "Installation complete!"

echo ""
echo -e "${BOLD}Zveltio Studio:${RESET}  http://${SERVER_IP}:${ZVELTIO_PORT}/admin"
echo -e "${BOLD}API:${RESET}             http://${SERVER_IP}:${ZVELTIO_PORT}/api"
echo ""
echo -e "${BOLD}${YELLOW}Save these credentials — they will not be shown again:${RESET}"
echo ""
echo -e "  PostgreSQL password:    ${POSTGRES_PASSWORD}"
echo -e "  Valkey password:        ${VALKEY_PASSWORD}"
echo -e "  Better Auth secret:     ${BETTER_AUTH_SECRET}"
echo -e "  S3 access key:          ${S3_ACCESS_KEY}"
echo -e "  S3 secret key:          ${S3_SECRET_KEY}"
echo -e "  Mail encryption key:    ${MAIL_ENCRYPTION_KEY}"
echo -e "  AI key encryption key:  ${AI_KEY_ENCRYPTION_KEY}"
echo ""
echo -e "  Config file:            ${ZVELTIO_DIR}/.env"
echo ""
echo -e "${BOLD}Useful commands:${RESET}"
echo -e "  View logs:    journalctl -u zveltio -f"
echo -e "  Restart:      systemctl restart zveltio"
echo -e "  Update:       bash ${ZVELTIO_DIR}/update.sh"
echo -e "  Status:       systemctl status zveltio"
echo ""
