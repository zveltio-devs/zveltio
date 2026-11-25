#!/usr/bin/env bash
# ADR 0062 probe "fail-alone", step 2: one run per call, on the VM, as the operator.
#   bash failalone.sh <runner|inline> <loop|leak|crash> [outdir=/tmp/failalone]
# The engine (compiled beta.132 binary, NODE_ENV=production) runs in
# `systemd-run --scope -p MemoryMax=1G -p MemorySwapMax=0` as the `zveltio` user,
# unpinned (2 vCPU: the engine, PG, the runner and the generator share them).
# Trees come from failalone-prep.sh. The engine's stdout/stderr and the runner
# units' journal are kept with a timestamp per line (epoch s); the load starts
# BASE s in, the misbehaving action from then on.
set -euo pipefail
MODE="${1:?runner|inline}"; EXT="${2:?loop|leak|crash}"; OUT="${3:-/tmp/failalone}"
RUN=/opt/zveltio-run; HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-30}"; TOTAL="${TOTAL:-110}"; SETTLE="${SETTLE:-15}"
SCOPE=bench-engine; MEMBER=bench-member@test.local
mkdir -p "$OUT"; P="$OUT/$MODE-$EXT"; : >"$P.log"
trap 'sudo systemctl stop $SCOPE.scope 2>/dev/null; sudo systemctl stop "zveltio-ext-runner@*" 2>/dev/null; sudo -u postgres psql -qX zveltio_bench -c "UPDATE zv_extension_registry SET is_enabled=false WHERE name LIKE '"'"'probe/%'"'"'" >/dev/null' EXIT
sudo systemctl stop 'zveltio-ext-runner@*' 2>/dev/null || true
sudo systemctl stop "$SCOPE.scope" 2>/dev/null || true; sudo systemctl reset-failed "$SCOPE.scope" 2>/dev/null || true
sudo rm -f /etc/systemd/system/zveltio-ext-runner@.service.d/bench-cpu.conf; sudo systemctl daemon-reload

if [ $MODE = runner ]; then
  TREE=ext-bad-worker; KEYLINE=operator-bad.line; PLAIN=probe/plain; BAD=probe/$EXT
else # a name the catalog knows: see failalone-prep.sh
  TREE=ext-bad-inline; KEYLINE=registry-bad.line; PLAIN=analytics/quality
  case $EXT in loop) BAD=operations/traceability;; leak) BAD=developer/api-docs;; crash) BAD=integrations/migrators;; esac
fi
NAMES="finance/invoicing,$PLAIN,$BAD"
SFX=; [ $MODE = inline ] && SFX=_i
# The registry decides what is enabled: only these three; the bad one is fresh (no crash history in the engine, new process).
sudo -u postgres psql -qX zveltio_bench -c "UPDATE zv_extension_registry SET is_enabled=false WHERE name <> ALL(string_to_array('$NAMES', ','))" >/dev/null
sudo -u postgres psql -qX zveltio_bench -c "INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled) SELECT n, n, NULL, true, true FROM unnest(string_to_array('$NAMES', ',')) n ON CONFLICT (tenant_id, name) DO UPDATE SET is_installed = true, is_enabled = true" >/dev/null
sudo install -d -o zveltio -g zveltio /tmp/zv-home /tmp/zv-data
# Rule 2 of the probe: the load must be able to pass the per-IP /ext limit.
ENVV=(PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/zv-home NODE_ENV=production PORT=3000 HOST=127.0.0.1
  ZVELTIO_SINGLE_INSTANCE=1 ZVELTIO_REGISTRATION_ENABLED=1 RATE_LIMIT_ALLOWLIST=127.0.0.0/8
  DATABASE_URL=postgres://zveltio_app:benchpass@127.0.0.1:5432/zveltio_bench
  BETTER_AUTH_SECRET=$(printf 'a%.0s' {1..64}) FIELD_ENCRYPTION_KEY=$(printf 'b%.0s' {1..64})
  BETTER_AUTH_URL=http://127.0.0.1:3000 STORAGE_LOCAL_DIR=/tmp/zv-data
  EXTENSIONS_DIR=$RUN/$TREE ZVELTIO_EXTENSIONS="$NAMES" "$(cat $RUN/bench/$KEYLINE)")
[ $MODE = runner ] && ENVV+=(ZVELTIO_EXT_TRANSPORT=runner)
ts() { while IFS= read -r l; do printf '%s %s\n' "$(date +%s.%N)" "$l"; done; }
JSTART=$(date '+%F %T')
cd $RUN
sudo systemd-run --quiet --scope --unit="$SCOPE" -p MemoryMax=1G -p MemorySwapMax=0 -- \
  setpriv --reuid=zveltio --regid=zveltio --clear-groups env -i "${ENVV[@]}" "$RUN/zveltio" 2>&1 | grep --line-buffered -v -E '<-- |--> .*\[(32|36)m' | ts >"$P.log" &
up=0
for _ in $(seq 1 1800); do curl -sf -m1 http://127.0.0.1:3000/health >/dev/null 2>&1 && { up=1; break; }; sleep 0.1; done
[ $up = 1 ] || { echo "engine never answered /health"; tail -20 "$P.log"; exit 1; }
sleep "$SETTLE"
# grants for the member (SQL; the member exists from small-vps setup)
ID=$(sudo -u postgres psql -qXAt zveltio_bench -c "SELECT id FROM \"user\" WHERE email='$MEMBER'")
for g in probe_notes$SFX:read probe_notes$SFX:create "probe_${EXT}_log$SFX:execute"; do
  sudo -u postgres psql -qX zveltio_bench -c "INSERT INTO zvd_permissions (ptype,v0,v1,v2,v3) VALUES ('p','$ID','*','${g%%:*}','${g##*:}') ON CONFLICT DO NOTHING" >/dev/null
done
sleep "${GRANT_WAIT:-5}"; curl -s -m3 http://127.0.0.1:3000/health >"$P.health-before"
# a sampler for the engine's own CPU/RSS and the units, once a second
( while :; do
    printf '%s engine_rss_kb=%s units=%s\n' "$(date +%s.%N)" \
      "$(for p in $(cat /sys/fs/cgroup$(systemctl show -p ControlGroup --value $SCOPE.scope 2>/dev/null)/cgroup.procs 2>/dev/null); do sudo awk '/^Rss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null; done | paste -sd+ | bc 2>/dev/null)" \
      "$(systemctl list-units --plain --no-legend 'zveltio-ext-runner@*' | awk '{print $1":"$4}' | paste -sd,)"
    sleep 1; done >"$P.samples" ) &
SAMP=$!
LOADSTART=$(date +%s.%N)
COLL=probe_notes$SFX taskset -c 1 bun "$HERE/failalone-load.ts" "$BAD" "$BASE" "$TOTAL" "$P.requests.jsonl" >"$P.summary.json" || true
kill $SAMP 2>/dev/null || true
echo "load_start=$LOADSTART base_s=$BASE total_s=$TOTAL bad_start=$(echo "$LOADSTART + $BASE" | bc)" >"$P.times"
curl -s -m3 -o "$P.health-after" -w '%{http_code}\n' http://127.0.0.1:3000/health >>"$P.times" || echo "health-after: unreachable" >>"$P.times"
sudo journalctl -u 'zveltio-ext-runner@*' --since "$JSTART" -o short-iso-precise --no-pager >"$P.units.log" 2>&1 || true
sudo systemctl show $SCOPE.scope -p ActiveState,Result -p MemoryPeak >>"$P.times" 2>&1 || true
cat /sys/fs/cgroup/system.slice/$SCOPE.scope/memory.events >>"$P.times" 2>/dev/null || true
sudo journalctl -k --since "$JSTART" --no-pager 2>/dev/null | grep -i 'oom\|killed process' >>"$P.times" || true
echo "done $MODE $EXT"
