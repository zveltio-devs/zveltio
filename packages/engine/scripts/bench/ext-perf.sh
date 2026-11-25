#!/usr/bin/env bash
# Runs ext-perf.ts on the box: rounds x pools x modes, each in its own engine
# process, as the engine's user (the runner only answers that uid).
#   bash ext-perf.sh [rounds=2] [outdir=/tmp/ext-perf]
# Needs: the database from scripts/bootstrap-db-role.sh, `zveltio ext-runner
# setup` done, the sibling zveltio-extensions checkout, `bun install`.
set -euo pipefail
ROUNDS="${1:-2}"; OUT="${2:-/tmp/ext-perf}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DBURL="${BENCH_DATABASE_URL:-postgres://zveltio_app:benchpass@127.0.0.1:5432/zveltio_bench}"
mkdir -p "$OUT"; chmod 777 "$OUT"
sudo bash "$HERE/mem-sample.sh" & SAMPLER=$!
trap 'sudo pkill -f mem-sample.sh || true' EXIT
for round in $(seq 1 "$ROUNDS"); do
  for pool in default 40 10; do
    for mode in inline process runner; do
      f="$OUT/r${round}-${mode}-pool${pool}.json"
      echo "== round $round mode $mode pool $pool"
      sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
        TEST_DATABASE_URL="$DBURL" ZVELTIO_REGISTRATION_ENABLED=1 DB_POOL_MAX="$([ "$pool" = default ] && echo '' || echo "$pool")" \
        bun "$HERE/ext-perf.ts" "$mode" --out "$f" --cold "$([ "$pool" = default ] && echo 20 || echo 0)" \
        >"$OUT/r${round}-${mode}-pool${pool}.log" 2>&1 || { echo "FAILED $f"; tail -5 "$OUT/r${round}-${mode}-pool${pool}.log"; }
    done
  done
done
