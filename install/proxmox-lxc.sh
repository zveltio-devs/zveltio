#!/usr/bin/env bash
# =============================================================================
# Zveltio — Proxmox LXC Installer
# =============================================================================
# Runs on the Proxmox HOST (not inside a container).
# Creates a Debian 12 LXC container and runs the native installer
# (install/install.sh) inside it.
#
# Usage:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/zveltio-devs/zveltio/master/install/proxmox-lxc.sh)"
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

# ── Install inside the container ───────────────────────────────────────────────
# The native installer does the rest: PostgreSQL, Valkey, SeaweedFS, Bun, the
# checksum-verified binary, Studio, systemd and the admin account. This script
# used to carry its own copy of all that, and the copy drifted: it resolved
# `latest` through /releases/latest (404 while only prereleases exist), fell
# back to cloning a `main` branch that does not exist, installed the binary
# unverified and never installed Studio.
header "Installing Zveltio inside container ${CTID}"

# Tags carry a `v`, and so must the version handed over: installers from
# releases up to 3.0.0-beta.68 use it verbatim in download URLs.
INSTALLER_REF="master"
if [[ "$ZVELTIO_VERSION" != "latest" ]]; then
  ZVELTIO_VERSION="v${ZVELTIO_VERSION#v}"
  INSTALLER_REF="$ZVELTIO_VERSION"
fi

pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && \
  curl -fsSL https://raw.githubusercontent.com/zveltio-devs/zveltio/${INSTALLER_REF}/install/install.sh -o /root/zveltio-install.sh"
pct exec "$CTID" -- env ZVELTIO_PORT="$ZVELTIO_PORT" ZVELTIO_VERSION="$ZVELTIO_VERSION" \
  bash /root/zveltio-install.sh

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
echo -e "  Credentials: ${BOLD}pct exec ${CTID} -- cat /opt/zveltio/.env${RESET}"
echo ""
echo -e "${BOLD}Useful commands:${RESET}"
echo -e "  Enter container:  pct enter ${CTID}"
echo -e "  View logs:        pct exec ${CTID} -- journalctl -u zveltio -f"
echo -e "  Restart:          pct exec ${CTID} -- systemctl restart zveltio"
echo -e "  Update:           pct exec ${CTID} -- bash /opt/zveltio/update.sh"
echo ""
