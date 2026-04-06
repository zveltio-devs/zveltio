#!/usr/bin/env bash
# =============================================================================
# Zveltio — Proxmox LXC Installer
# =============================================================================
# Runs on the Proxmox HOST (not inside a container).
# Creates a Debian 12 LXC container, installs Bun + PostgreSQL 16 + Valkey +
# SeaweedFS + Zveltio engine, and configures systemd services for auto-start.
#
# Usage:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/zveltio/zveltio/main/install/proxmox-lxc.sh)"
#
# Or locally:
#   bash install/proxmox-lxc.sh
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

# ── Defaults (override via env vars) ─────────────────────────────────────────
CTID="${ZVELTIO_CTID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 200)}"
CT_HOSTNAME="${ZVELTIO_HOSTNAME:-zveltio}"
CT_RAM="${ZVELTIO_RAM:-2048}"         # MB
CT_SWAP="${ZVELTIO_SWAP:-512}"        # MB
CT_DISK="${ZVELTIO_DISK:-20}"         # GB
CT_CORES="${ZVELTIO_CORES:-2}"
CT_STORAGE="${ZVELTIO_STORAGE:-local-lvm}"
CT_BRIDGE="${ZVELTIO_BRIDGE:-vmbr0}"
ZVELTIO_PORT="${ZVELTIO_PORT:-4000}"
ZVELTIO_VERSION="${ZVELTIO_VERSION:-latest}"

DEBIAN_TEMPLATE="debian-12-standard_12.7-1_amd64.tar.zst"
TEMPLATE_URL="http://download.proxmox.com/images/system/${DEBIAN_TEMPLATE}"

# ── Checks ────────────────────────────────────────────────────────────────────
header "Zveltio — Proxmox LXC Installer"

if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root on the Proxmox host."
  exit 1
fi

if ! command -v pct &>/dev/null; then
  error "pct not found. This script must run on a Proxmox VE host."
  exit 1
fi

if pct status "$CTID" &>/dev/null; then
  error "Container $CTID already exists. Choose a different CTID: ZVELTIO_CTID=201 bash install/proxmox-lxc.sh"
  exit 1
fi

# ── Interactive config (skip if non-interactive) ──────────────────────────────
if [[ -t 0 ]]; then
  echo ""
  echo -e "${BOLD}Container configuration${RESET}"
  read -r -p "  Container ID   [${CTID}]: "    _in; CTID="${_in:-$CTID}"
  read -r -p "  Hostname       [${CT_HOSTNAME}]: " _in; CT_HOSTNAME="${_in:-$CT_HOSTNAME}"
  read -r -p "  RAM (MB)       [${CT_RAM}]: "  _in; CT_RAM="${_in:-$CT_RAM}"
  read -r -p "  Disk (GB)      [${CT_DISK}]: " _in; CT_DISK="${_in:-$CT_DISK}"
  read -r -p "  CPU cores      [${CT_CORES}]: " _in; CT_CORES="${_in:-$CT_CORES}"
  read -r -p "  Storage pool   [${CT_STORAGE}]: " _in; CT_STORAGE="${_in:-$CT_STORAGE}"
  read -r -p "  Network bridge [${CT_BRIDGE}]: " _in; CT_BRIDGE="${_in:-$CT_BRIDGE}"
  read -r -p "  Zveltio port   [${ZVELTIO_PORT}]: " _in; ZVELTIO_PORT="${_in:-$ZVELTIO_PORT}"
  echo ""
fi

# ── Generate secrets ─────────────────────────────────────────────────────────
gen_secret() { openssl rand -hex 32; }

POSTGRES_PASSWORD=$(gen_secret)
VALKEY_PASSWORD=$(gen_secret)
BETTER_AUTH_SECRET=$(gen_secret)
MAIL_ENCRYPTION_KEY=$(gen_secret)
AI_KEY_ENCRYPTION_KEY=$(gen_secret)
GRAFANA_ADMIN_PASSWORD=$(gen_secret | cut -c1-16)
S3_ACCESS_KEY=$(gen_secret | cut -c1-20)
S3_SECRET_KEY=$(gen_secret)

# ── Download template ─────────────────────────────────────────────────────────
header "Downloading Debian 12 template"

TEMPLATE_PATH="/var/lib/vz/template/cache/${DEBIAN_TEMPLATE}"
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  info "Downloading ${DEBIAN_TEMPLATE}..."
  wget -q --show-progress -O "$TEMPLATE_PATH" "$TEMPLATE_URL" || {
    # Try pveam download as fallback
    pveam update
    pveam download local "$DEBIAN_TEMPLATE" || {
      error "Failed to download template. Try: pveam update && pveam download local ${DEBIAN_TEMPLATE}"
      exit 1
    }
  }
  success "Template downloaded"
else
  success "Template already exists"
fi

# ── Create LXC container ──────────────────────────────────────────────────────
header "Creating LXC container ${CTID} (${CT_HOSTNAME})"

pct create "$CTID" "local:vztmpl/${DEBIAN_TEMPLATE}" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CT_CORES" \
  --memory "$CT_RAM" \
  --swap "$CT_SWAP" \
  --rootfs "${CT_STORAGE}:${CT_DISK}" \
  --net0 "name=eth0,bridge=${CT_BRIDGE},ip=dhcp,firewall=1" \
  --ostype debian \
  --unprivileged 1 \
  --features "nesting=1" \
  --start 1 \
  --onboot 1

success "Container created and started"

# Wait for container to be ready
info "Waiting for container to boot..."
sleep 5

# ── Install Zveltio inside the container ─────────────────────────────────────
header "Installing Zveltio inside container ${CTID}"

# Escape variables for the heredoc passed to pct exec
pct exec "$CTID" -- bash -c "
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo '--- Updating system ---'
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget gnupg2 lsb-release ca-certificates \
  apt-transport-https software-properties-common unzip git openssl \
  build-essential

echo '--- Installing PostgreSQL 16 ---'
install -d /usr/share/postgresql-common/pgdg
curl -fsSL 'https://www.postgresql.org/media/keys/ACCC4CF8.asc' \
  | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt \$(lsb_release -cs)-pgdg main' \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq postgresql-16 postgresql-16-pgvector

echo '--- Configuring PostgreSQL ---'
systemctl enable postgresql
systemctl start postgresql

su -c \"psql -c \\\"CREATE USER zveltio WITH PASSWORD '${POSTGRES_PASSWORD}';\\\"\" postgres || true
su -c \"psql -c \\\"CREATE DATABASE zveltio OWNER zveltio;\\\"\" postgres || true
su -c \"psql -d zveltio -c 'CREATE EXTENSION IF NOT EXISTS vector;'\" postgres || true
su -c \"psql -d zveltio -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'\" postgres || true

# Tune PostgreSQL
cat > /etc/postgresql/16/main/conf.d/zveltio.conf << 'EOF'
shared_buffers = 256MB
effective_cache_size = 768MB
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

echo '--- Installing Valkey ---'
VALKEY_VER='8.0.1'
VALKEY_ARCH=\$(dpkg --print-architecture)
wget -q \"https://github.com/valkey-io/valkey/releases/download/\${VALKEY_VER}/valkey-\${VALKEY_VER}-\${VALKEY_ARCH}-debian-bookworm.tar.gz\" \
  -O /tmp/valkey.tar.gz
tar -xzf /tmp/valkey.tar.gz -C /tmp
mv /tmp/valkey-\${VALKEY_VER}-\${VALKEY_ARCH}-debian-bookworm/bin/valkey-server /usr/local/bin/
mv /tmp/valkey-\${VALKEY_VER}-\${VALKEY_ARCH}-debian-bookworm/bin/valkey-cli /usr/local/bin/
rm -rf /tmp/valkey*

useradd -r -s /bin/false valkey 2>/dev/null || true
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
maxmemory 256mb
maxmemory-policy allkeys-lru
EOF

cat > /etc/systemd/system/valkey.service << 'EOF'
[Unit]
Description=Valkey In-Memory Data Store
After=network.target

[Service]
User=valkey
Group=valkey
ExecStart=/usr/local/bin/valkey-server /etc/valkey/valkey.conf
ExecStop=/usr/local/bin/valkey-cli -a \${VALKEY_PASSWORD} shutdown
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable valkey
systemctl start valkey

echo '--- Installing Bun ---'
curl -fsSL https://bun.sh/install | bash
export PATH=\"\$HOME/.bun/bin:\$PATH\"
BUN_BIN=\"\$HOME/.bun/bin/bun\"

# Make bun available system-wide
ln -sf \"\$BUN_BIN\" /usr/local/bin/bun

echo '--- Installing SeaweedFS ---'
SWFS_VER='3.68'
SWFS_ARCH=\$(uname -m)
case \"\$SWFS_ARCH\" in
  x86_64)  SWFS_ARCH='linux_amd64' ;;
  aarch64) SWFS_ARCH='linux_arm64' ;;
  *)       echo 'Unsupported arch for SeaweedFS'; exit 1 ;;
esac
wget -q \"https://github.com/seaweedfs/seaweedfs/releases/download/\${SWFS_VER}/linux_amd64.tar.gz\" \
  -O /tmp/seaweedfs.tar.gz
tar -xzf /tmp/seaweedfs.tar.gz -C /usr/local/bin weed
chmod +x /usr/local/bin/weed
rm /tmp/seaweedfs.tar.gz

mkdir -p /var/lib/seaweedfs/{master,volume,filer}
useradd -r -s /bin/false seaweedfs 2>/dev/null || true
chown -R seaweedfs:seaweedfs /var/lib/seaweedfs

cat > /etc/systemd/system/seaweedfs.service << 'EOF'
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
EOF

systemctl daemon-reload
systemctl enable seaweedfs
systemctl start seaweedfs
sleep 3

echo '--- Downloading Zveltio ---'
mkdir -p /opt/zveltio
ZVELTIO_VERSION='${ZVELTIO_VERSION}'
if [[ \"\$ZVELTIO_VERSION\" == 'latest' ]]; then
  ZVELTIO_VERSION=\$(curl -fsSL https://api.github.com/repos/zveltio/zveltio/releases/latest | grep '\"tag_name\"' | cut -d'\"' -f4 || echo 'main')
fi

if [[ \"\$ZVELTIO_VERSION\" == 'main' ]] || [[ \"\$ZVELTIO_VERSION\" == '' ]]; then
  warn 'No release found, installing from source (main branch)...'
  git clone --depth=1 https://github.com/zveltio/zveltio.git /opt/zveltio/src
  cd /opt/zveltio/src
  bun install --frozen-lockfile
  cd packages/engine && bun run build:prod
  cp -r dist /opt/zveltio/engine
  cp -r ../../extensions /opt/zveltio/ 2>/dev/null || true
else
  wget -q \"https://github.com/zveltio/zveltio/releases/download/\${ZVELTIO_VERSION}/zveltio-linux-x64\" \
    -O /opt/zveltio/zveltio
  chmod +x /opt/zveltio/zveltio
fi

echo '--- Creating .env ---'
cat > /opt/zveltio/.env << EOF
PORT=${ZVELTIO_PORT}
HOST=0.0.0.0
NODE_ENV=production

DATABASE_URL=postgresql://zveltio:${POSTGRES_PASSWORD}@127.0.0.1:5432/zveltio
NATIVE_DATABASE_URL=postgresql://zveltio:${POSTGRES_PASSWORD}@127.0.0.1:5432/zveltio

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

chmod 600 /opt/zveltio/.env
useradd -r -s /bin/false -d /opt/zveltio zveltio 2>/dev/null || true
chown -R zveltio:zveltio /opt/zveltio

echo '--- Running migrations ---'
cd /opt/zveltio
if [[ -f engine/index.js ]]; then
  DATABASE_URL=\"postgresql://zveltio:${POSTGRES_PASSWORD}@127.0.0.1:5432/zveltio\" \
    bun engine/index.js migrate 2>/dev/null || true
fi

echo '--- Creating zveltio systemd service ---'
cat > /etc/systemd/system/zveltio.service << 'EOF'
[Unit]
Description=Zveltio BaaS Engine
After=network.target postgresql.service valkey.service seaweedfs.service
Wants=postgresql.service valkey.service seaweedfs.service

[Service]
User=zveltio
WorkingDirectory=/opt/zveltio
EnvironmentFile=/opt/zveltio/.env
ExecStart=/usr/local/bin/bun /opt/zveltio/engine/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zveltio

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/opt/zveltio
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zveltio
systemctl start zveltio

echo '--- Done ---'
"

# ── Get container IP ──────────────────────────────────────────────────────────
sleep 3
CT_IP=$(pct exec "$CTID" -- bash -c "ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'" 2>/dev/null || echo "<container-ip>")

# ── Summary ───────────────────────────────────────────────────────────────────
header "Installation complete!"

echo ""
echo -e "${BOLD}Container:${RESET}   CT${CTID} — ${CT_HOSTNAME}"
echo -e "${BOLD}IP Address:${RESET}  ${CT_IP}"
echo -e "${BOLD}Zveltio:${RESET}     http://${CT_IP}:${ZVELTIO_PORT}/admin"
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
echo -e "${BOLD}Useful commands:${RESET}"
echo -e "  Enter container:        pct enter ${CTID}"
echo -e "  View logs:              pct exec ${CTID} -- journalctl -u zveltio -f"
echo -e "  Restart Zveltio:        pct exec ${CTID} -- systemctl restart zveltio"
echo -e "  Update Zveltio:         pct exec ${CTID} -- bash /opt/zveltio/update.sh"
echo ""
