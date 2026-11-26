#!/usr/bin/env bash
# ADR 0062 probe "small VPS", step 2: one state per call, on the VM, as the operator.
#   bash small-vps.sh <state> [outdir=/tmp/small-vps]
# states
#   setup        boot on the runner once (migrations, units), make the member, grant it, stop
#   warm-inline  boot inline once (core packages into the tree), stop
#   alone        engine with no extension
#   inline       the 37 inside the engine (registry-signed tree). Three of them (ai,
#                communications/mail, compliance/ro/efactura) declare jobs, which run in a
#                runner unit of their own even then: those 3 units are counted
#   runner       37 on the systemd runner, every unit running (operator setting always on
#                for all 37); then the setting flips to a 10 s idle timeout and the engine
#                stops every unit itself (ADR 0062 d3, #1918: no mask, no crash counted)
#   runner-load  runner at the default runtime settings (only invoicing always on), then
#                createInvoice 3 lines, concurrency 5, 2 minutes
# The engine runs in `systemd-run --scope -p AllowedCPUs=0 -p MemoryMax=1G` as the
# `zveltio` user; the runner units get the same CPU pin from a drop-in (installed
# here, removed by `small-vps.sh unpin`). Memory (RSS/PSS from smaps_rollup) of the
# scope's processes and of every runner unit is read here, with sudo, by the operator.
# Needs small-vps-prep.sh done. One JSON object per line goes to <outdir>/<state>.jsonl.
set -euo pipefail
# The operator's runtime settings (ADR 0062 d3) for every name: '' deletes them.
setrt() {
  if [ -z "$1" ]; then
    sudo -u postgres psql -qX zveltio_bench -c "DELETE FROM zv_settings WHERE key LIKE 'ext_runtime:%'" >/dev/null
  else
    sudo -u postgres psql -qX zveltio_bench -c "INSERT INTO zv_settings (key, value) SELECT 'ext_runtime:' || n, '$1'::jsonb FROM unnest(string_to_array('$(cat /opt/zveltio-run/bench/names)', ',')) n ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null
  fi
}
trap 'sudo systemctl stop bench-engine.scope 2>/dev/null || true; sudo systemctl stop "zveltio-ext-runner@*" 2>/dev/null || true; setrt ""' EXIT
STATE="${1:?state}"; OUT="${2:-/tmp/small-vps}"
RUN=/opt/zveltio-run
HERE="$(cd "$(dirname "$0")" && pwd)"
SETTLE="${SETTLE:-20}"
LOAD_SECS="${LOAD_SECS:-120}"; LOAD_CONC="${LOAD_CONC:-5}"
MEMBER=bench-member@test.local
SCOPE=bench-engine
DROPIN=/etc/systemd/system/zveltio-ext-runner@.service.d/bench-cpu.conf
mkdir -p "$OUT"; J="$OUT/$STATE.jsonl"; : >"$J"; LOG="$OUT/$STATE.log"

if [ "$STATE" = unpin ]; then sudo rm -f "$DROPIN"; sudo systemctl daemon-reload; exit 0; fi
if [ ! -f "$DROPIN" ]; then
  sudo install -d /etc/systemd/system/zveltio-ext-runner@.service.d
  printf '[Service]\nAllowedCPUs=0\n' | sudo tee "$DROPIN" >/dev/null
  sudo systemctl daemon-reload
fi
sudo systemctl stop 'zveltio-ext-runner@*' 2>/dev/null || true
sudo systemctl stop "$SCOPE.scope" 2>/dev/null || true

emit() { printf '%s\n' "$1" >>"$J"; }
sample() { # <phase>: every process of the scope and of every runner unit
  local phase="$1" cg pid rss pss name unit
  cg=$(systemctl show -p ControlGroup --value "$SCOPE.scope")
  local -a groups=("engine:$cg")
  for unit in $(systemctl list-units --plain --no-legend 'zveltio-ext-runner@*' | awk '{print $1}'); do
    groups+=("$unit:$(systemctl show -p ControlGroup --value "$unit")")
  done
  for g in "${groups[@]}"; do
    name="${g%%:*}"; cg="${g#*:}"
    for pid in $(cat "/sys/fs/cgroup${cg}/cgroup.procs"); do
      [[ $pid =~ ^[0-9]+$ ]] || continue
      read -r rss pss < <(sudo awk '/^Rss:/{r=$2} /^Pss:/{p=$2} END{print r, p}' "/proc/$pid/smaps_rollup") || continue
      emit "$(printf '{"phase":"%s","group":"%s","pid":%s,"rss_kb":%s,"pss_kb":%s}' "$phase" "$name" "$pid" "$rss" "$pss")"
    done
    local f="/sys/fs/cgroup${cg}"
    emit "$(printf '{"phase":"%s","cgroup":"%s","current":%s,"peak":%s,"swap":%s,"swap_peak":%s,"events":"%s"}' "$phase" "$name" \
      "$(cat $f/memory.current 2>/dev/null || echo 0)" "$(cat $f/memory.peak 2>/dev/null || echo 0)" \
      "$(cat $f/memory.swap.current 2>/dev/null || echo 0)" "$(cat $f/memory.swap.peak 2>/dev/null || echo 0)" \
      "$(tr '\n' ' ' <$f/memory.events 2>/dev/null)")"
  done
  emit "$(printf '{"phase":"%s","system":{"mem_used_kb":%s,"swap_used_kb":%s,"units":%s}}' "$phase" \
    "$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t-a}' /proc/meminfo)" \
    "$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print t-f}' /proc/meminfo)" \
    "$(systemctl list-units --plain --no-legend 'zveltio-ext-runner@*' | wc -l)")"
}

# ── the engine ────────────────────────────────────────────────────────────────
case "$STATE" in
  setup|runner|runner-load) TREE=ext-worker; NAMES=$(cat $RUN/bench/names); TRANSPORT=runner ;;
  warm-inline|inline)       TREE=ext-inline; NAMES=$(cat $RUN/bench/names); TRANSPORT= ;;
  alone)                    TREE=ext-inline; NAMES=; TRANSPORT= ;;
  *) echo "unknown state $STATE"; exit 2 ;;
esac
# A member reaches an extension only when the registry says it is enabled (what
# `markInstalled` does in the harness); the `alone` state must have none.
if [ -n "$NAMES" ]; then
  sudo -u postgres psql -qX zveltio_bench -c "INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled) SELECT n, n, NULL, true, true FROM unnest(string_to_array('$NAMES', ',')) n ON CONFLICT (tenant_id, name) DO UPDATE SET is_installed = true, is_enabled = true"
else
  sudo -u postgres psql -qX zveltio_bench -c "DELETE FROM zv_extension_registry WHERE tenant_id IS NULL"
fi
sudo install -d -o zveltio -g zveltio /tmp/zv-home /tmp/zv-data
ENVV=(PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/zv-home NODE_ENV=production PORT=3000 HOST=127.0.0.1
  ZVELTIO_SINGLE_INSTANCE=1 ZVELTIO_REGISTRATION_ENABLED=1
  DATABASE_URL=postgres://zveltio_app:benchpass@127.0.0.1:5432/zveltio_bench
  BETTER_AUTH_SECRET=$(printf 'a%.0s' {1..64}) FIELD_ENCRYPTION_KEY=$(printf 'b%.0s' {1..64})
  BETTER_AUTH_URL=http://127.0.0.1:3000 STORAGE_LOCAL_DIR=/tmp/zv-data
  EXTENSIONS_DIR=$RUN/$TREE ZVELTIO_EXTENSIONS="$NAMES"
  "$(cat $RUN/bench/registry.line)" "$(cat $RUN/bench/operator.line)")
[ -n "$TRANSPORT" ] && ENVV+=(ZVELTIO_EXT_TRANSPORT=$TRANSPORT)
# The ext route allows 600 requests a minute per IP; the generator is on loopback.
[ "$STATE" = runner-load ] && ENVV+=(RATE_LIMIT_ALLOWLIST=127.0.0.0/8)

setrt ""
[ "$STATE" = runner ] && setrt '{"alwaysOn":true,"idleTimeoutSeconds":10}'
t0=$(date +%s%N)
sudo systemd-run --quiet --scope --unit="$SCOPE" -p AllowedCPUs=0 -p MemoryMax=1G -- \
  setpriv --reuid=zveltio --regid=zveltio --clear-groups env -i "${ENVV[@]}" "$RUN/zveltio" >"$LOG" 2>&1 &
up=0
for _ in $(seq 1 3600); do
  curl -sf -m1 http://127.0.0.1:3000/health >/dev/null 2>&1 && { up=1; break; }
  sleep 0.05
done
boot_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[ $up = 1 ] || { echo "engine never answered /health"; tail -20 "$LOG"; sudo systemctl stop "$SCOPE.scope"; exit 1; }
loaded=$(grep -c 'Extensions loaded' "$LOG" || true)
emit "$(printf '{"phase":"boot","state":"%s","boot_ms":%s,"extensions_line":"%s"}' "$STATE" "$boot_ms" "$(grep -m1 'Extensions loaded' "$LOG" | cut -c1-120)")"
echo "boot $STATE: ${boot_ms} ms; $(grep -c '❌' "$LOG" || true) refusal lines in log"
sleep "$SETTLE"

case "$STATE" in
  setup)
    id=$(bun "$HERE/small-vps-load.ts" setup "$MEMBER")
    echo "member $id"
    for g in invoices:read invoices:create invoices:update invoices:execute invoice_lines:read \
             invoice_lines:create document_series:read company_profile:read; do
      sudo -u postgres psql -qX zveltio_bench -c "INSERT INTO zvd_permissions (ptype,v0,v1,v2,v3) VALUES ('p','$id','*','${g%%:*}','${g##*:}') ON CONFLICT DO NOTHING"
    done ;;
  alone|inline) sample up ;;
  runner)
    sample running
    curl -s -m5 http://127.0.0.1:3000/health >"$OUT/runner-health-running.json" || true
    setrt '{"alwaysOn":false,"idleTimeoutSeconds":10}'
    sleep $((SETTLE * 2)) # each always-on unit re-reads its setting every 10 s, then idles 10 s
    emit "$(printf '{"phase":"idle-stopped","health":"%s","units_back":%s}' \
      "$(curl -s -m3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)" \
      "$(systemctl list-units --plain --no-legend 'zveltio-ext-runner@*' | wc -l)")"
    curl -s -m5 http://127.0.0.1:3000/health >"$OUT/runner-health-idle.json" || true
    sample idle-stopped
    emit "$(printf '{"phase":"idle-stopped","engine_log_crash_lines":%s,"disabled_lines":%s}' \
      "$(grep -c 'crash [0-9]/5' "$LOG" || true)" "$(grep -ci 'disabled' "$LOG" || true)")" ;;
  runner-load)
    sample running
    taskset -c 1 bun "$HERE/small-vps-load.ts" run "$LOAD_SECS" "$LOAD_CONC" "$MEMBER" >"$OUT/load.json"
    cat "$OUT/load.json"
    sample after-load
    emit "$(printf '{"phase":"after-load","health":"%s"}' "$(curl -s -m3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)")" ;;
esac
emit "$(printf '{"phase":"end","kernel_oom":%s}' "$(sudo journalctl -k --since '-20min' --no-pager 2>/dev/null | grep -ci 'out of memory\|oom-kill' || true)")"
sudo systemctl stop "$SCOPE.scope" 2>/dev/null || true
sudo systemctl stop 'zveltio-ext-runner@*' 2>/dev/null || true
echo done "$STATE"
