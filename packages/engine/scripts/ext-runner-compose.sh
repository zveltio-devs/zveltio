#!/usr/bin/env bash
# Isolation test for the container runner (RFC extension-runner, step 4),
# against docker-compose.ext-runner.yml itself — its user, capabilities,
# network and volumes — with the test stack in ext-runner-compose.test.yml.
#
# The probe extension (ext-runner-isolation.ts) runs twice from the "engine":
#   process — a child under the engine's uid: MUST read the .env and the
#             environment and reach the network (proves the probe works);
#   runner  — the runner container: MUST do none of it, MUST run under a
#             uid of its own (not root, not the engine's), and MUST NOT be able
#             to write into the runner's socket directory.
# A connection from a uid other than the engine's is refused (SO_PEERCRED), and
# an extension's process does not outlive its connection.
#
#   bash packages/engine/scripts/ext-runner-compose.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export ZV_SRC="$ROOT"
dc() { docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.ext-runner.yml" \
  -f "$ROOT/packages/engine/scripts/ext-runner-compose.test.yml" "$@"; }
trap 'dc down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

dc up -d --build --wait engine ext-runner >/dev/null

SOCK=/run/zveltio-ext/runner.sock
PROBE=/src/packages/engine/scripts/ext-runner-isolation.ts
# A public address: the runtime's SSRF guard refuses private ones on its own,
# which would hide what the container network does.
URL="${PROBE_URL:-http://example.com/}"
probe() { dc exec -T -e PROBE_URL="$URL" -e PROBE_WRITE=/run/zveltio-ext/evil "$@"; }
fail=0

out=$(probe engine bun "$PROBE" process /opt/zveltio/.env /data/extensions/p)
echo "process: $out"
[ "$(grep -o hunter2 <<<"$out" | wc -l)" -ge 2 ] && grep -q '"fetch":"HTTP' <<<"$out" \
  || { echo "FAIL: process transport should read both secrets and reach $URL (probe broken?)"; fail=1; }

for ext in r1 r2; do
  out=$(probe engine bun "$PROBE" runner /opt/zveltio/.env "/data/extensions/$ext" "$SOCK")
  echo "runner:  $out"
  grep -q '"transport":"runner"' <<<"$out" || { echo "FAIL: runner probe gave no answer"; fail=1; }
  grep -q hunter2 <<<"$out" && { echo "FAIL: runner transport read an engine secret"; fail=1; }
  grep -q '"fetch":"HTTP' <<<"$out" && { echo "FAIL: runner transport reached $URL"; fail=1; }
  grep -q '"write":"WROTE"' <<<"$out" && { echo "FAIL: an extension wrote into the socket directory"; fail=1; }
  uid=$(grep -o '"uid":[0-9]*' <<<"$out" | cut -d: -f2 || true)
  [ -n "$uid" ] && [ "$uid" -ge 200000 ] || { echo "FAIL: extension ran as uid ${uid:-?}"; fail=1; }
  uids+=("$uid")
done
[ "${uids[0]}" != "${uids[1]}" ] || { echo "FAIL: two extensions got the same uid"; fail=1; }

# A closed connection ends its extension's process. (The probe exits on EOF by
# itself; one that ignores EOF is what CAP_KILL in the overlay is for.)
sleep 1
left=$(dc exec -T ext-runner sh -c 'cat /proc/[0-9]*/status 2>/dev/null' | awk '/^Uid:/ && $2 >= 200000' | wc -l)
[ "$left" = 0 ] || { echo "FAIL: $left extension processes outlived their connection"; fail=1; }

out=$(dc exec -T -u 4242 engine bun "$PROBE" runner /opt/zveltio/.env /tmp/x "$SOCK" 2>&1 || true)
echo "foreign uid: $out"
grep -q "channel ended" <<<"$out" && dc logs ext-runner 2>&1 | grep -q "refused a connection from uid 4242" \
  || { echo "FAIL: runner served a uid other than the engine"; fail=1; }
dc logs ext-runner 2>&1 | tail -5

[ "$fail" = 0 ] && echo "PASS: ext-runner compose isolation"
exit "$fail"
