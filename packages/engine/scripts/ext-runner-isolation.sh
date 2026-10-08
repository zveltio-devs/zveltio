#!/usr/bin/env bash
# Isolation test for the extension runner (RFC extension-runner, step 3).
#
# Needs a real uid boundary, so it runs in a container: an "engine" user with a
# 0600 .env and a secret in its environment, and a `zveltio-ext` user running
# `ext-runner`. The same probe extension runs over two transports:
#   process — today's out-of-thread child, under the engine's uid: MUST leak
#             (proves the probe can see a secret when one is reachable);
#   runner  — the runner service, under zveltio-ext: MUST read neither.
# A third check: a connection from the zveltio-ext uid is refused (SO_PEERCRED).
#
# Network egress is not tested here: on bare metal the unit's IPAddressDeny
# enforces it, and that needs systemd as root (RFC step 4 covers containers).
#
#   bash packages/engine/scripts/ext-runner-isolation.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IMAGE="${BUN_IMAGE:-oven/bun:1.3.14}"

docker run --rm -v "${ROOT}:/src:ro" "${IMAGE}" bash -euo pipefail -c '
cd /tmp
useradd -r -M zveltio
useradd -r -M zveltio-ext
mkdir -p /opt/zveltio /run/zveltio-ext /opt/ext
echo "SECRET=hunter2-env-file" > /opt/zveltio/.env
chown -R zveltio:zveltio /opt/zveltio && chmod 600 /opt/zveltio/.env
chown zveltio-ext /run/zveltio-ext
chown zveltio /opt/ext && chmod 755 /opt/ext
export ZVELTIO_EXT_RUNNER_SOCKET=/run/zveltio-ext/runner.sock
E="/src/packages/engine"

as_engine() { setpriv --reuid=zveltio --regid=zveltio --init-groups env -i PATH="$PATH" HOME=/tmp \
  SECRET=hunter2-process-env ZVELTIO_EXT_RUNNER_SOCKET="$ZVELTIO_EXT_RUNNER_SOCKET" "$@"; }

setpriv --reuid=zveltio-ext --regid=zveltio-ext --init-groups env -i PATH="$PATH" HOME=/tmp \
  ZVELTIO_ENGINE_UID="$(id -u zveltio)" ZVELTIO_EXT_RUNNER_SOCKET="$ZVELTIO_EXT_RUNNER_SOCKET" \
  bun "$E/src/binary-entry.ts" ext-runner >/tmp/runner.log 2>&1 &
for _ in $(seq 50); do [ -S "$ZVELTIO_EXT_RUNNER_SOCKET" ] && break; sleep 0.1; done

fail=0

out=$(as_engine bun "$E/scripts/ext-runner-isolation.ts" process /opt/zveltio/.env /opt/ext/p)
echo "process: $out"
[ "$(grep -o hunter2 <<<"$out" | wc -l)" -ge 2 ] || { echo "FAIL: process transport should read both secrets (probe broken?)"; fail=1; }

out=$(as_engine bun "$E/scripts/ext-runner-isolation.ts" runner /opt/zveltio/.env /opt/ext/r)
echo "runner:  $out"
grep -q "\"transport\":\"runner\"" <<<"$out" || { echo "FAIL: runner probe gave no answer"; fail=1; }
grep -q hunter2 <<<"$out" && { echo "FAIL: runner transport read an engine secret"; fail=1; }

# Any uid but the engine is refused: the connection closes before a runtime starts.
out=$(setpriv --reuid=zveltio-ext --regid=zveltio-ext --init-groups env -i PATH="$PATH" HOME=/tmp \
  ZVELTIO_EXT_RUNNER_SOCKET="$ZVELTIO_EXT_RUNNER_SOCKET" \
  bun "$E/scripts/ext-runner-isolation.ts" runner /opt/zveltio/.env /tmp/x 2>&1 || true)
echo "foreign uid: $out"
grep -q "channel ended" <<<"$out" && grep -q "refused a connection from uid $(id -u zveltio-ext)" /tmp/runner.log \
  || { echo "FAIL: runner served a uid other than the engine"; fail=1; }
cat /tmp/runner.log

[ "$fail" = 0 ] && echo "PASS: ext-runner isolation"
exit "$fail"
'
