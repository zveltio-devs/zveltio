#!/usr/bin/env bash
# ADR 0062 probe "restrictive PaaS (simulated)", on the VM, as the operator.
#   bash paas.sh <prep|control|strict|strict-user> [outdir=/tmp/paas]
# The engine container image (Dockerfile `standalone` target, loaded as
# zv-bench-standalone), one container, host network (the VM's PG), with
#   prep         build the extension tree: finance/invoicing (registry-signed:
#                first-party, runs inline) + probe/plain (operator-signed, engine.isolation
#                worker: runs on the runner). Owned by 100:101, mounted on /data/extensions
#   control      docker defaults (root, default caps) + --memory 1g: what the image does today
#   strict       --cap-drop ALL --security-opt no-new-privileges --memory 1g (the PaaS)
#   strict-user  strict + --user 100:101 (a PaaS that forces a non-root user)
# Records: container state and exit code, its log, /health, the extension lines, one call
# to each extension (createInvoice inline; a data-API insert into the worker's collection).
set -euo pipefail
STATE="${1:?state}"; OUT="${2:-/tmp/paas}"; RUN=/opt/zveltio-run; C=zv-paas-$STATE; IMG=zv-bench-standalone
mkdir -p "$OUT"; P="$OUT/$STATE"
if [ "$STATE" = prep ]; then
  T=$RUN/ext-paas; sudo rm -rf "$T"; sudo install -d "$T/finance" "$T/probe"
  sudo cp -a $RUN/ext-bad-inline/finance/invoicing "$T/finance/invoicing"
  sudo cp -a $RUN/ext-bad-inline/package.json $RUN/ext-bad-inline/bun.lock $RUN/ext-bad-inline/node_modules "$T"/ 2>/dev/null || true
  sudo cp -a $RUN/ext-bad-worker/probe/plain "$T/probe/plain"
  sudo chown -R 100:101 "$T"; sudo ls "$T" "$T/probe" "$T/finance"; exit 0
fi
docker rm -f "$C" >/dev/null 2>&1 || true
sudo systemctl stop 'zveltio-ext-runner@*' bench-engine.scope 2>/dev/null || true
sudo -u postgres psql -qX zveltio_bench -c "UPDATE zv_extension_registry SET is_enabled=false WHERE name <> ALL(ARRAY['finance/invoicing','probe/plain'])" >/dev/null
sudo -u postgres psql -qX zveltio_bench -c "INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled) SELECT n, n, NULL, true, true FROM unnest(ARRAY['finance/invoicing','probe/plain']) n ON CONFLICT (tenant_id, name) DO UPDATE SET is_installed = true, is_enabled = true" >/dev/null
FLAGS=(--memory 1g)
case "$STATE" in
  control) ;;
  strict) FLAGS+=(--cap-drop ALL --security-opt no-new-privileges) ;;
  strict-user) FLAGS+=(--cap-drop ALL --security-opt no-new-privileges --user 100:101) ;;
  *) echo "unknown state"; exit 2 ;;
esac
docker run -d --name "$C" "${FLAGS[@]}" --network host \
  -v $RUN/ext-paas:/data/extensions \
  -e HOST=127.0.0.1 -e ZVELTIO_REGISTRATION_ENABLED=1 -e RATE_LIMIT_ALLOWLIST=127.0.0.0/8 \
  -e DATABASE_URL=postgres://zveltio_app:benchpass@127.0.0.1:5432/zveltio_bench \
  -e BETTER_AUTH_SECRET=$(printf 'a%.0s' {1..64}) -e FIELD_ENCRYPTION_KEY=$(printf 'b%.0s' {1..64}) \
  -e BETTER_AUTH_URL=http://127.0.0.1:3000 -e STORAGE_LOCAL_DIR=/data/storage \
  -e ZVELTIO_EXTENSIONS=finance/invoicing,probe/plain \
  -e "$(cat $RUN/bench/registry-bad.line)" -e "$(cat $RUN/bench/operator-bad.line)" \
  "$IMG" >"$P.id"
up=0
for _ in $(seq 1 600); do
  curl -sf -m1 http://127.0.0.1:3000/health >/dev/null 2>&1 && { up=1; break; }
  [ "$(docker inspect -f '{{.State.Running}}' "$C")" = true ] || break
  sleep 0.2
done
sleep 15
docker inspect -f 'running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} caps={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} mem={{.HostConfig.Memory}} user={{.Config.User}}' "$C" >"$P.state"
echo "health_up=$up http=$(curl -s -m3 -o "$P.health" -w '%{http_code}' http://127.0.0.1:3000/health || true)" >>"$P.state"
cat "$P.health" 2>/dev/null >>"$P.state" || true
docker logs "$C" 2>&1 | grep -v -E '<-- |--> .*\[(32|36)m' >"$P.log" || true
if [ "$up" = 1 ]; then
  docker exec "$C" sh -c 'for p in 1 $(pgrep -f "zveltio" | head -5); do echo "pid $p $(tr "\0" " " </proc/$p/cmdline | cut -c1-80) $(grep -E "^(Uid|CapEff|CapBnd|NoNewPrivs)" /proc/$p/status | tr "\n\t" "  ")"; done' >"$P.procs" 2>&1 || true
  # one member, the same as the other probes
  bun "$(dirname "$0")/paas-calls.ts" >"$P.calls" 2>&1 || true; cat "$P.calls"
fi
echo "state: $(cat $P.state | head -1)"; echo "--- log"; grep -i -E 'extension|runner|worker|refus|cap|setuid|uid|error|❌|⚠|entrypoint|permission' "$P.log" | cut -c1-260 | head -40
docker stop -t 5 "$C" >/dev/null 2>&1 || true
