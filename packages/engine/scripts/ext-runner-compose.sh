#!/usr/bin/env bash
# Isolation test for the container runner (RFC extension-runner, steps 4 and 9),
# against the runner the release compose ships — scripts/generate-compose.sh's
# docker-compose.engine.yml: its user, capabilities, network and volumes — with
# the test stack in ext-runner-compose.test.yml.
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
# Edge functions (step 5, edge-runner-isolation.ts): under the engine
# (ZVELTIO_EDGE_TRANSPORT unset) an edge function reaches the network; with
# ZVELTIO_EDGE_TRANSPORT=runner it does not, and the uid it runs under — read
# from outside while the invocation is held — cannot read the engine's .env.
# Step 10: a function that declares ZVELTIO_EGRESS goes to the runner by
# default and reaches a listed host through the engine; an unlisted host, a
# private address it lists, and a function that lists nothing reach nothing.
#
#   bash packages/engine/scripts/ext-runner-compose.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export ZV_SRC="$ROOT"
GEN=$(mktemp -d)
bash "$ROOT/scripts/generate-compose.sh" 0.0.0-test "$GEN" >/dev/null
# The engine service's required settings; the test stack replaces that service.
export DATABASE_URL=postgres://x VALKEY_URL=redis://x S3_ENDPOINT=http://x S3_ACCESS_KEY=x S3_SECRET_KEY=x \
  BETTER_AUTH_SECRET=x BETTER_AUTH_URL=http://x
dc() { docker compose --project-directory "$ROOT" -f "$GEN/docker-compose.engine.yml" \
  -f "$ROOT/packages/engine/scripts/ext-runner-compose.test.yml" "$@"; }
trap 'dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$GEN"' EXIT

dc up -d --build --wait engine ext-runner >/dev/null || { dc logs ext-runner | tail -40; exit 1; }

SOCK=/run/zveltio-ext/runner.sock
# Both handed over world-writable with no sticky bit (as an emptyDir is).
modes=$(dc exec -T ext-runner stat -c %a /run/zveltio-ext /tmp | tr '\n' ' ')
[ "$modes" = "755 1777 " ] || { echo "FAIL: socket dir and /tmp left as: $modes"; fail_early=1; }
PROBE=/src/packages/engine/scripts/ext-runner-isolation.ts
# A public address: the runtime's SSRF guard refuses private ones on its own,
# which would hide what the container network does.
URL="${PROBE_URL:-http://example.com/}"
probe() { dc exec -T -e PROBE_URL="$URL" -e PROBE_WRITE=/run/zveltio-ext/evil "$@"; }
fail=${fail_early:-0}

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

EDGE=/src/packages/engine/scripts/edge-runner-isolation.ts
out=$(dc exec -T -e PROBE_URL="$URL" engine bun "$EDGE" 2>&1 || true)
echo "edge process: ${out:0:300}"
grep -q '"fetch":"HTTP' <<<"$out" \
  || { echo "FAIL: an edge function under the engine's uid should reach $URL (probe broken?)"; fail=1; }
# Held for 10 s: measured from outside while it lives, under its own uid.
edge_out=$(mktemp)
dc exec -T -e PROBE_URL="$URL" -e PROBE_HOLD_MS=10000 -e ZVELTIO_EDGE_TRANSPORT=runner \
  engine bun "$EDGE" >"$edge_out" 2>&1 &
edge_pid=$!
# Polled: the invocation may take a moment to start. awk reads to the end (an
# early `exit` makes docker exec die of EPIPE, 255 under pipefail), and a
# process that ends between the glob and the read is not an error.
uid=
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  uid=$( { dc exec -T ext-runner sh -c 'cat /proc/[0-9]*/status 2>/dev/null; true' || true; } \
    | awk '/^Uid:/ && $2 >= 200000 && !u {u=$2} END {print u}')
  [ -n "$uid" ] && break
done
[ -n "$uid" ] || { echo "FAIL: no edge invocation found on the runner"; fail=1; }
# Positive control: the runner's image holds the engine's 0600 .env, readable by its owner.
{ dc exec -T -u 100 ext-runner cat /opt/zveltio/.env || true; } | grep -q hunter2 \
  || { echo "FAIL: the runner holds no engine secret to test against (probe broken?)"; fail=1; }
if [ -n "$uid" ]; then
  [ "$uid" -ge 200000 ] || { echo "FAIL: edge function ran as uid $uid"; fail=1; }
  { dc exec -T -u "$uid" ext-runner cat /opt/zveltio/.env 2>/dev/null || true; } | grep -q hunter2 \
    && { echo "FAIL: the edge function's uid $uid reads an engine secret"; fail=1; }
fi
wait "$edge_pid" || true
out=$(cat "$edge_out"); rm -f "$edge_out"
echo "edge runner:  $out (uid ${uid:-?})"
grep -q '"transport":"runner"' <<<"$out" || { echo "FAIL: edge runner probe gave no answer"; fail=1; }
grep -q '"fetch":"HTTP' <<<"$out" && { echo "FAIL: an edge function on the runner reached $URL"; fail=1; }
grep -q 'declares no egress' <<<"$out" || { echo "FAIL: an undeclared function's fetch was not refused by the engine"; fail=1; }

# Step 10: egress through the engine. HOST is $URL's host, listed.
HOST=$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$URL")
egress() { dc exec -T -e PROBE_URL="$1" -e PROBE_EGRESS="$2" -e ZVELTIO_EDGE_TRANSPORT=runner \
  engine bun "$EDGE" 2>&1 || true; }
out=$(egress "$URL" "$HOST")
echo "edge egress listed:   ${out:0:300}"
grep -q '"fetch":"HTTP' <<<"$out" || { echo "FAIL: a listed host was not reached through the engine"; fail=1; }
out=$(egress "http://example.org/" "$HOST")
echo "edge egress unlisted: ${out:0:300}"
grep -q 'is not in this function' <<<"$out" || { echo "FAIL: an unlisted host was not refused"; fail=1; }
out=$(egress "http://169.254.169.254/latest/meta-data/" "$HOST 169.254.169.254")
echo "edge egress private:  ${out:0:300}"
grep -q 'internal/private address blocked' <<<"$out" \
  || { echo "FAIL: a private address was not refused by the SSRF guard"; fail=1; }

# And by default (no ZVELTIO_EDGE_TRANSPORT), a declared function is sent to
# the runner: held, its uid is read from outside, as above.
edge_out=$(mktemp)
dc exec -T -e PROBE_URL="$URL" -e PROBE_HOLD_MS=6000 -e PROBE_EGRESS="$HOST" \
  engine bun "$EDGE" >"$edge_out" 2>&1 &
edge_pid=$!
duid=
for _ in 1 2 3 4 5; do
  sleep 1
  duid=$( { dc exec -T ext-runner sh -c 'cat /proc/[0-9]*/status 2>/dev/null; true' || true; } \
    | awk '/^Uid:/ && $2 >= 200000 && !u {u=$2} END {print u}')
  [ -n "$duid" ] && break
done
wait "$edge_pid" || true
out=$(cat "$edge_out"); rm -f "$edge_out"
echo "edge egress default:  ${out:0:300} (uid ${duid:-?})"
[ -n "$duid" ] || { echo "FAIL: a declared function did not run on the runner by default"; fail=1; }
grep -q '"transport":"runner"' <<<"$out" && grep -q '"fetch":"HTTP' <<<"$out" \
  || { echo "FAIL: a declared function on the default transport did not reach $HOST"; fail=1; }

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
