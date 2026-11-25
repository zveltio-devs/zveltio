#!/usr/bin/env bash
# Root helper for ext-perf.ts in runner mode: the runner's processes run under
# DynamicUser uids the engine cannot ptrace, so it writes their pids to
# /tmp/bench-mem/<id>.req and waits for <id>.ack with Rss/Pss of each.
#   sudo bash mem-sample.sh &
D=/tmp/bench-mem
mkdir -p "$D"; chmod 1777 "$D"
while true; do
  for r in "$D"/*.req; do
    [ -e "$r" ] || continue
    a="${r%.req}.ack"; [ -e "$a" ] && continue
    out=""
    while read -r pid; do
      [ -r "/proc/$pid/smaps_rollup" ] || continue
      rss=$(awk '/^Rss:/{print $2}' /proc/$pid/smaps_rollup); pss=$(awk '/^Pss:/{print $2}' /proc/$pid/smaps_rollup)
      cmd=$(tr '\0' ' ' </proc/$pid/cmdline | cut -c1-80)
      out+="{\"pid\":$pid,\"rss_kb\":$rss,\"pss_kb\":$pss,\"cmd\":\"${cmd//\"/}\"},"
    done <"$r"
    echo "[${out%,}]" >"$a.tmp" && mv "$a.tmp" "$a"; chmod 644 "$a"
  done
  sleep 0.1
done
