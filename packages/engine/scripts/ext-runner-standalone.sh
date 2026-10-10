#!/usr/bin/env bash
# Isolation test for the extension runner in ONE container (RFC
# extension-runner, "One container"): the Dockerfile's `standalone` target, which
# fly.toml, railway.json and render.yaml build, started as root through the
# image's real entrypoint (docker/zveltio-entrypoint.sh). The binary is a
# stand-in: `ext-runner` is the runner from source, anything else (`start`)
# sleeps where the engine would run.
#
# MUST hold: the engine (PID 1) runs as 100 with no capabilities and the runner
# transport; the runner runs as root with only SETUID/SETGID/KILL and none of
# the container's environment; through it an extension runs under a uid of its
# own, reads neither the engine's environment nor a world-readable file in
# /data/storage nor the engine's TMPDIR, and cannot write into the socket
# directory. Started as uid 100, the entrypoint is the binary and nothing else.
#
#   bash packages/engine/scripts/ext-runner-standalone.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IMG=zveltio-ext-runner-standalone-test
C=zveltio-ext-runner-standalone
trap 'docker rm -f "$C" "$C-user" >/dev/null 2>&1 || true' EXIT

docker build -q -t "$IMG" -f - "$ROOT" >/dev/null <<'EOF'
FROM oven/bun:1.3-alpine
RUN apk add --no-cache setpriv && addgroup -S -g 101 zveltio && adduser -S -u 100 -G zveltio zveltio && \
    mkdir -p /data/extensions /data/storage /run/zveltio-ext && chown -R 100:101 /data && \
    echo hunter2-upload > /data/storage/upload && chown 100:101 /data/storage/upload && \
    chmod 0644 /data/storage/upload && \
    printf '#!/bin/sh\ncase "$1" in ext-runner) exec bun /src/packages/engine/src/binary-entry.ts "$@";;\n*) exec sleep infinity;; esac\n' \
      > /usr/local/bin/zveltio && chmod +x /usr/local/bin/zveltio
COPY docker/zveltio-entrypoint.sh /usr/local/bin/zveltio-entrypoint
WORKDIR /data
ENV NODE_ENV=production
USER root
ENTRYPOINT ["/usr/local/bin/zveltio-entrypoint"]
CMD ["start"]
EOF

docker rm -f "$C" "$C-user" >/dev/null 2>&1 || true
docker run -d --name "$C" -e SECRET=hunter2-process-env -v "$ROOT:/src:ro" "$IMG" >/dev/null
SOCK=/run/zveltio-ext/runner.sock
for _ in $(seq 1 40); do docker exec "$C" test -S "$SOCK" && break; sleep 0.5; done
fail=0
status() { docker exec "$C" sh -c "awk '/^($2):/{print \$2}' /proc/$1/status"; }

[ "$(status 1 Uid)" = 100 ] || { echo "FAIL: the engine (PID 1) runs as uid $(status 1 Uid)"; fail=1; }
[ "$(status 1 CapEff)" = 0000000000000000 ] || { echo "FAIL: the engine kept capabilities"; fail=1; }
engine_env=$(docker exec -u 100:101 "$C" sh -c 'tr "\0" "\n" </proc/1/environ')
grep -qx ZVELTIO_EXT_TRANSPORT=runner <<<"$engine_env" && grep -qx "ZVELTIO_EXT_RUNNER_SOCKET=$SOCK" <<<"$engine_env" \
  || { echo "FAIL: the engine was not pointed at the runner"; fail=1; }
runner=$(docker exec "$C" sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" != $$ ] &&
  tr "\0" " " <$p/cmdline 2>/dev/null | grep -q "binary-entry.ts ext-runner" && echo ${p#/proc/}; done; true' | head -1)
[ -n "$runner" ] || { echo "FAIL: no runner process"; docker logs "$C" | tail -20; exit 1; }
[ "$(status "$runner" Uid)" = 0 ] && [ "$(status "$runner" CapEff)" = 00000000000000e0 ] \
  || { echo "FAIL: runner is uid $(status "$runner" Uid) with $(status "$runner" CapEff), not root with SETUID/SETGID/KILL"; fail=1; }
docker exec --privileged "$C" cat "/proc/$runner/environ" | grep -q hunter2 \
  && { echo "FAIL: the runner holds the container's environment"; fail=1; }

PROBE=/src/packages/engine/scripts/ext-runner-isolation.ts
probe() { docker exec -u 100:101 -e PROBE_WRITE=/run/zveltio-ext/evil "$C" bun "$PROBE" "$@"; }
out=$(probe process /data/storage/upload /data/extensions/p)
echo "process: $out"
[ "$(grep -o hunter2 <<<"$out" | wc -l)" -ge 2 ] \
  || { echo "FAIL: under the engine's uid the probe should read both secrets (probe broken?)"; fail=1; }
uids=()
for ext in r1 r2; do
  out=$(probe runner /data/storage/upload "/data/extensions/$ext" "$SOCK")
  echo "runner:  $out"
  grep -q '"transport":"runner"' <<<"$out" || { echo "FAIL: runner probe gave no answer"; fail=1; }
  grep -q hunter2 <<<"$out" && { echo "FAIL: an extension read an engine secret"; fail=1; }
  grep -q '"write":"WROTE"' <<<"$out" && { echo "FAIL: an extension wrote into the socket directory"; fail=1; }
  uid=$(grep -o '"uid":[0-9]*' <<<"$out" | cut -d: -f2 || true)
  [ -n "$uid" ] && [ "$uid" -ge 200000 ] || { echo "FAIL: extension ran as uid ${uid:-?}"; fail=1; }
  uids+=("${uid:-}")
done
[ "${uids[0]}" != "${uids[1]}" ] || { echo "FAIL: two extensions got the same uid"; fail=1; }
tmp=$(grep '^TMPDIR=' <<<"$engine_env" | cut -d= -f2)
[ -n "$tmp" ] && ! docker exec -u 200009:200009 "$C" ls "$tmp" >/dev/null 2>&1 \
  || { echo "FAIL: an extension's uid can list the engine's TMPDIR (${tmp:-unset})"; fail=1; }

# As the image's user, the entrypoint is the binary: no runner, nothing dropped.
docker run -d --name "$C-user" --user 100:101 -v "$ROOT:/src:ro" "$IMG" >/dev/null
sleep 2
docker exec "$C-user" sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" " "' | grep -q ext-runner \
  && { echo "FAIL: started as uid 100, the entrypoint started a runner"; fail=1; }
[ "$(docker exec "$C-user" cat /proc/1/cmdline | tr '\0' ' ')" = "sleep infinity " ] \
  || { echo "FAIL: started as uid 100, PID 1 is not the binary"; fail=1; }

[ "$fail" = 0 ] && echo "PASS: ext-runner standalone isolation"
exit "$fail"
