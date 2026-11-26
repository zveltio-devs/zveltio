#!/usr/bin/env bash
# Runs ext-perf.ts on the box: rounds x pools x modes, each in its own engine
# process, as the engine's user (the runner only answers that uid).
#   bash ext-perf.sh [rounds=2] [outdir=/tmp/ext-perf]
# Needs: the database from scripts/bootstrap-db-role.sh, `zveltio ext-runner
# setup` done, the sibling zveltio-extensions checkout, `bun install`, sudo.
#
# Memory of a runner's processes (another uid, unreadable to the engine) is read
# here, by the operator: when the bench prints "@@CHECKPOINT <label>" this driver
# lists the runner units itself, takes the pids from their cgroups (numeric only)
# and `sudo cat`s smaps_rollup into <run>.mem. No root process reads anything
# another user can write.
set -euo pipefail
ROUNDS="${1:-2}"; OUT="${2:-/tmp/ext-perf}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DBURL="${BENCH_DATABASE_URL:-postgres://zveltio_app:benchpass@127.0.0.1:5432/zveltio_bench}"
mkdir -p "$OUT"; chmod 777 "$OUT"

sample() { # <label> <file>: one JSON object per process of every runner unit
  local unit cg pid rss pss cmd
  for unit in $(systemctl list-units --plain --no-legend 'zveltio-ext-runner@*' | awk '{print $1}'); do
    cg=$(systemctl show -p ControlGroup --value "$unit")
    for pid in $(cat "/sys/fs/cgroup${cg}/cgroup.procs"); do
      [[ $pid =~ ^[0-9]+$ ]] || continue
      read -r rss pss < <(sudo awk '/^Rss:/{r=$2} /^Pss:/{p=$2} END{print r, p}' "/proc/$pid/smaps_rollup") || continue
      cmd=$(sudo tr '\0' ' ' <"/proc/$pid/cmdline" | cut -c1-80 | tr -cd '[:print:]' | tr -d '"\\')
      printf '{"when":"%s","pid":%s,"rss_kb":%s,"pss_kb":%s,"cmd":"%s"}\n' "$1" "$pid" "$rss" "$pss" "$cmd" >>"$2"
    done
  done
}

for round in $(seq 1 "$ROUNDS"); do
  for pool in ${POOLS:-default 40 10}; do
    for mode in ${MODES:-inline process runner}; do
      run="$OUT/r${round}-${mode}-pool${pool}"
      echo "== round $round mode $mode pool $pool"
      : >"$run.mem"
      sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
        TEST_DATABASE_URL="$DBURL" ZVELTIO_REGISTRATION_ENABLED=1 DB_POOL_MAX="$([ "$pool" = default ] && echo '' || echo "$pool")" \
        bun "$HERE/ext-perf.ts" "$mode" --out "$run.json" --cold "$([ "$pool" = default ] && echo 20 || echo 0)" 2>&1 |
        while IFS= read -r line; do
          case "$line" in
            "@@CHECKPOINT "*) sample "${line#@@CHECKPOINT }" "$run.mem" ;;
            *) echo "$line" >>"$run.log" ;;
          esac
        done || { echo "FAILED $run"; tail -5 "$run.log"; }
    done
  done
done
