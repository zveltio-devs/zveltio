#!/usr/bin/env bash
# Root helper for ext-perf.ts in runner mode: the runner's processes run under
# DynamicUser uids the engine cannot ptrace, so the engine writes their pids to
# /run/bench-mem/<id>.req and waits for <id>.ack with Rss/Pss of each.
# The directory is root:<engine group> 0770 (not world-writable); only requests
# owned by the engine user are served, and only numeric pids are read.
#   sudo ENGINE_USER=zveltio bash mem-sample.sh &
set -u
EU="${ENGINE_USER:-zveltio}"
D=/run/bench-mem
EUID_N=$(id -u "$EU")
install -d -m 0770 -o root -g "$(id -gn "$EU")" "$D"
umask 077
while true; do
  for r in "$D"/*.req; do
    [ -e "$r" ] || continue
    a="${r%.req}.ack"; [ -e "$a" ] && continue
    [ "$(stat -c %u "$r")" = "$EUID_N" ] || continue
    out=""
    while read -r pid || [ -n "$pid" ]; do
      [[ $pid =~ ^[0-9]+$ ]] || continue
      [ -r "/proc/$pid/smaps_rollup" ] || continue
      rss=$(awk '/^Rss:/{print $2}' "/proc/$pid/smaps_rollup"); pss=$(awk '/^Pss:/{print $2}' "/proc/$pid/smaps_rollup")
      cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" | cut -c1-80 | tr -cd '[:print:]' | tr -d '"\\')
      out+="{\"pid\":$pid,\"rss_kb\":$rss,\"pss_kb\":$pss,\"cmd\":\"$cmd\"},"
    done <"$r"
    echo "[${out%,}]" >"$a.tmp" && chown "$EU" "$a.tmp" && mv "$a.tmp" "$a"
  done
  sleep 0.1
done
