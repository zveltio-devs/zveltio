#!/usr/bin/env bash
# =============================================================================
# Zveltio — Proxmox LXC Installer
# =============================================================================
# Runs on the Proxmox HOST (not inside a container).
# Creates a Debian 12 LXC container and installs Zveltio natively:
# Bun + PostgreSQL 18 + pgvector + Valkey + SeaweedFS + systemd services.
#
# Usage:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/zveltio/zveltio/main/install/proxmox-lxc.sh)"
#
# Or locally:
#   bash install/proxmox-lxc.sh
#
# Override defaults:
#   ZVELTIO_RAM=4096 ZVELTIO_PORT=4000 bash install/proxmox-lxc.sh
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
ZVELTIO_PORT="${ZVELTIO_PORT:-3000}"
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
  error "Container $CTID already exists. Set a different ID: ZVELTIO_CTID=201 bash install/proxmox-lxc.sh"
  exit 1
fi

# ── Interactive config ────────────────────────────────────────────────────────
if [[ -t 0 ]]; then
  echo ""
  echo -e "${BOLD}Container configuration${RESET}"
  read -r -p "  Container ID   [${CTID}]: "       _in; CTID="${_in:-$CTID}"
  read -r -p "  Hostname       [${CT_HOSTNAME}]: " _in; CT_HOSTNAME="${_in:-$CT_HOSTNAME}"
  read -r -p "  RAM (MB)       [${CT_RAM}]: "     _in; CT_RAM="${_in:-$CT_RAM}"
  read -r -p "  Disk (GB)      [${CT_DISK}]: "    _in; CT_DISK="${_in:-$CT_DISK}"
  read -r -p "  CPU cores      [${CT_CORES}]: "   _in; CT_CORES="${_in:-$CT_CORES}"
  read -r -p "  Storage pool   [${CT_STORAGE}]: " _in; CT_STORAGE="${_in:-$CT_STORAGE}"
  read -r -p "  Network bridge [${CT_BRIDGE}]: "  _in; CT_BRIDGE="${_in:-$CT_BRIDGE}"
  read -r -p "  Zveltio port   [${ZVELTIO_PORT}]: " _in; ZVELTIO_PORT="${_in:-$ZVELTIO_PORT}"
  echo ""
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

# ── PostgreSQL tuning based on container RAM ──────────────────────────────────
PG_SHARED_BUFFERS=$(( CT_RAM / 8 ))
PG_EFFECTIVE_CACHE=$(( CT_RAM * 3 / 8 ))
(( PG_SHARED_BUFFERS < 32 )) && PG_SHARED_BUFFERS=32
(( PG_EFFECTIVE_CACHE < 64 )) && PG_EFFECTIVE_CACHE=64
VALKEY_MAX_MEM=$(( CT_RAM / 4 ))
(( VALKEY_MAX_MEM > 1024 )) && VALKEY_MAX_MEM=1024

info "Container RAM: ${CT_RAM}MB → pg shared_buffers=${PG_SHARED_BUFFERS}MB, valkey=${VALKEY_MAX_MEM}MB"

# ── Download Debian 12 template ───────────────────────────────────────────────
header "Downloading Debian 12 template"

TEMPLATE_PATH="/var/lib/vz/template/cache/${DEBIAN_TEMPLATE}"
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  info "Downloading ${DEBIAN_TEMPLATE}..."
  wget -q --show-progress -O "$TEMPLATE_PATH" "$TEMPLATE_URL" || {
    pveam update
    pveam download local "$DEBIAN_TEMPLATE" || {
      error "Failed to download template. Try: pveam update && pveam download local ${DEBIAN_TEMPLATE}"
      exit 1
    }
  }
  success "Template downloaded"
else
  success "Template already cached"
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

success "Container ${CTID} created and started"

info "Waiting for container to boot..."
sleep 6

# ── Install everything inside the container ───────────────────────────────────
header "Installing Zveltio inside container ${CTID}"

pct exec "$CTID" -- bash -euo pipefail << CONTAINER_SCRIPT
export DEBIAN_FRONTEND=noninteractive

echo '==> System update'
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget gnupg2 lsb-release ca-certificates \
  apt-transport-https software-properties-common unzip git openssl build-essential

echo '==> PostgreSQL 18 + pgvector'
install -d /usr/share/postgresql-common/pgdg
curl -fsSL 'https://www.postgresql.org/media/keys/ACCC4CF8.asc' \
  | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] \
  https://apt.postgresql.org/pub/repos/apt \$(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq postgresql-18 postgresql-18-pgvector
systemctl enable postgresql
systemctl start postgresql

su -c "psql -c \"CREATE USER zveltio WITH PASSWORD '${POSTGRES_PASSWORD}';\"" postgres 2>/dev/null || true
su -c "psql -c \"CREATE DATABASE zveltio OWNER zveltio;\"" postgres 2>/dev/null || true
su -c "psql -d zveltio -c 'CREATE EXTENSION IF NOT EXISTS vector;'" postgres
su -c "psql -d zveltio -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'" postgres

cat > /etc/postgresql/18/main/conf.d/zveltio.conf << 'EOF'
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
echo "PostgreSQL 18 configured (shared_buffers=${PG_SHARED_BUFFERS}MB)"

echo '==> Valkey'
VALKEY_VER='8.0.2'
VALKEY_INSTALLED=false
VALKEY_PKG_MANAGED=false

# 1. Package manager — apt works on Debian 13+/Ubuntu 24.04+ natively
if apt-get install -y -qq valkey 2>/dev/null; then
  VALKEY_INSTALLED=true
  VALKEY_PKG_MANAGED=true
  echo "Valkey installed via apt"
fi

# 2. Pre-built binary — fallback for Debian 12 and older distros
if [[ "\$VALKEY_INSTALLED" == "false" ]]; then
  CT_ARCH=\$(dpkg --print-architecture)
  if [[ "\$CT_ARCH" == "amd64" || "\$CT_ARCH" == "arm64" ]]; then
    for distro in bookworm noble jammy; do
      TARBALL="valkey-\${VALKEY_VER}-\${distro}-\${CT_ARCH}.tar.gz"
      URL="https://github.com/valkey-io/valkey/releases/download/\${VALKEY_VER}/\${TARBALL}"
      echo "Trying \${TARBALL}..."
      if wget -q "\$URL" -O /tmp/valkey.tar.gz 2>/dev/null; then
        VALKEY_DIR=\$(tar -tzf /tmp/valkey.tar.gz 2>/dev/null | head -1 | cut -d/ -f1)
        tar -xzf /tmp/valkey.tar.gz -C /tmp
        if [[ -f "/tmp/\${VALKEY_DIR}/bin/valkey-server" ]]; then
          mv "/tmp/\${VALKEY_DIR}/bin/valkey-server" /usr/local/bin/
          mv "/tmp/\${VALKEY_DIR}/bin/valkey-cli" /usr/local/bin/
          VALKEY_INSTALLED=true
        elif [[ -f "/tmp/\${VALKEY_DIR}/valkey-server" ]]; then
          mv "/tmp/\${VALKEY_DIR}/valkey-server" /usr/local/bin/
          mv "/tmp/\${VALKEY_DIR}/valkey-cli" /usr/local/bin/
          VALKEY_INSTALLED=true
        fi
        rm -rf /tmp/valkey* "/tmp/\${VALKEY_DIR}" 2>/dev/null || true
        if [[ "\$VALKEY_INSTALLED" == "true" ]]; then
          echo "Valkey \${VALKEY_VER} binary installed (\${TARBALL})"
          break
        fi
      fi
    done
  fi
fi

# 3. Build from source — last resort
if [[ "\$VALKEY_INSTALLED" == "false" ]]; then
  echo "Building Valkey from source..."
  wget -q "https://github.com/valkey-io/valkey/archive/refs/tags/\${VALKEY_VER}.tar.gz" -O /tmp/valkey-src.tar.gz
  tar -xzf /tmp/valkey-src.tar.gz -C /tmp
  make -C "/tmp/valkey-\${VALKEY_VER}" -j\$(nproc) install
  rm -rf /tmp/valkey-src.tar.gz "/tmp/valkey-\${VALKEY_VER}"
  echo "Valkey \${VALKEY_VER} built from source"
fi

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
maxmemory ${VALKEY_MAX_MEM}mb
maxmemory-policy allkeys-lru
EOF

if [[ "\$VALKEY_PKG_MANAGED" == "true" ]]; then
  VALKEY_SVC="valkey-server"
  systemctl is-enabled valkey-server &>/dev/null || VALKEY_SVC="valkey"
  systemctl daemon-reload
  systemctl enable "\$VALKEY_SVC"
  systemctl restart "\$VALKEY_SVC"
else
  cat > /etc/systemd/system/valkey.service << 'SVCEOF'
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
SVCEOF

  systemctl daemon-reload
  systemctl enable valkey
  systemctl start valkey
fi
echo "Valkey running (maxmemory=${VALKEY_MAX_MEM}MB)"

echo '==> SeaweedFS'
SWFS_VER='3.68'
case "\$(uname -m)" in
  x86_64)  SWFS_FILE='linux_amd64.tar.gz' ;;
  aarch64) SWFS_FILE='linux_arm64.tar.gz' ;;
  *)       echo "Unsupported arch for SeaweedFS: \$(uname -m)"; exit 1 ;;
esac
wget -q "https://github.com/seaweedfs/seaweedfs/releases/download/\${SWFS_VER}/\${SWFS_FILE}" \
  -O /tmp/seaweedfs.tar.gz
tar -xzf /tmp/seaweedfs.tar.gz -C /usr/local/bin weed
chmod +x /usr/local/bin/weed
rm /tmp/seaweedfs.tar.gz

useradd -r -s /bin/false seaweedfs 2>/dev/null || true
mkdir -p /var/lib/seaweedfs/{master,volume,filer}
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

echo '==> Bun'
curl -fsSL https://bun.sh/install | bash
export PATH="\$HOME/.bun/bin:\$PATH"
ln -sf "\$HOME/.bun/bin/bun" /usr/local/bin/bun
echo "Bun \$(bun --version) installed"

echo '==> Zveltio binary'
mkdir -p /opt/zveltio

ZVELTIO_VERSION='${ZVELTIO_VERSION}'
if [[ "\$ZVELTIO_VERSION" == 'latest' ]]; then
  ZVELTIO_VERSION=\$(curl -fsSL https://api.github.com/repos/zveltio/zveltio/releases/latest \
    | grep '"tag_name"' | cut -d'"' -f4 || echo '')
fi

BINARY_INSTALLED=false
if [[ -n "\$ZVELTIO_VERSION" && "\$ZVELTIO_VERSION" != 'main' ]]; then
  BINARY_URL="https://github.com/zveltio/zveltio/releases/download/\${ZVELTIO_VERSION}/zveltio-linux-\$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
  if curl -fsSL --head "\$BINARY_URL" &>/dev/null; then
    wget -q "\$BINARY_URL" -O /opt/zveltio/zveltio
    chmod +x /opt/zveltio/zveltio
    BINARY_INSTALLED=true
    echo "Downloaded pre-built binary \${ZVELTIO_VERSION}"
  fi
fi

if [[ "\$BINARY_INSTALLED" == 'false' ]]; then
  echo 'No pre-built binary — building from source (takes a few minutes)'
  BRANCH="\${ZVELTIO_VERSION:-main}"
  [[ -z "\$BRANCH" ]] && BRANCH='main'
  git clone --depth=1 --branch "\$BRANCH" https://github.com/zveltio/zveltio.git /tmp/zveltio-src
  cd /tmp/zveltio-src
  BUN_MEMORY_LIMIT=2048 bun install --frozen-lockfile
  cd packages/engine
  BUN_MEMORY_LIMIT=2048 bun run build:prod
  cp -r dist/. /opt/zveltio/
  cp -r ../../extensions /opt/zveltio/ 2>/dev/null || true
  rm -rf /tmp/zveltio-src
fi

echo '==> Writing .env'
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

echo '==> Running migrations'
if [[ -f /opt/zveltio/zveltio ]]; then
  EXEC_START='/opt/zveltio/zveltio start'
  sudo -u zveltio bash -c 'cd /opt/zveltio && env \$(cat .env | xargs) ./zveltio migrate'
else
  EXEC_START="/usr/local/bin/bun /opt/zveltio/index.js"
  sudo -u zveltio bash -c 'cd /opt/zveltio && env \$(cat .env | xargs) bun index.js migrate'
fi

echo '==> Creating admin account (interactive)'
if [[ -f /opt/zveltio/zveltio ]]; then
  sudo -u zveltio bash -c 'cd /opt/zveltio && env \$(cat .env | xargs) ./zveltio create-god'
else
  sudo -u zveltio bash -c 'cd /opt/zveltio && env \$(cat .env | xargs) bun index.js create-god'
fi

echo '==> systemd service'
cat > /etc/systemd/system/zveltio.service << EOF
[Unit]
Description=Zveltio BaaS Engine
After=network.target postgresql.service valkey.service seaweedfs.service
Wants=postgresql.service valkey.service seaweedfs.service

[Service]
User=zveltio
WorkingDirectory=/opt/zveltio
EnvironmentFile=/opt/zveltio/.env
ExecStart=\${EXEC_START}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zveltio
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
echo 'Zveltio started'
CONTAINER_SCRIPT

# ── Get container IP ──────────────────────────────────────────────────────────
sleep 3
CT_IP=$(pct exec "$CTID" -- bash -c \
  "ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'" 2>/dev/null || echo "<container-ip>")

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
echo -e "  Enter container:  pct enter ${CTID}"
echo -e "  View logs:        pct exec ${CTID} -- journalctl -u zveltio -f"
echo -e "  Restart:          pct exec ${CTID} -- systemctl restart zveltio"
echo -e "  Update:           pct exec ${CTID} -- bash /opt/zveltio/update.sh"
echo ""
