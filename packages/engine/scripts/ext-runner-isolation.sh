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
# The runner loads the socket ban into every process it starts and checks at
# start that what it spawns opens no socket, AF_UNIX included (ADR 0023). Under
# a profile shaped like its unit's (AF_UNIX left open) its extension still
# opens no AF_UNIX socket. Where the kernel refuses the filter it MUST refuse
# to start.
#
# Network egress and the per-extension uid are not tested here: they come from
# the systemd unit, which ext-runner-systemd.sh tests on a real systemd.
#
#   bash packages/engine/scripts/ext-runner-isolation.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IMAGE="${BUN_IMAGE:-oven/bun:1.4.4}"
# The unit's RestrictAddressFamilies=AF_UNIX and SystemCallFilter=~io_uring_*
# (SystemCallErrorNumber=EPERM), as a docker seccomp profile: socket() of any
# other family fails with EAFNOSUPPORT, io_uring with EPERM.
PROFILE=$(mktemp)
echo '{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[{"names":["socket"],"action":"SCMP_ACT_ERRNO",
  "errnoRet":97,"args":[{"index":0,"value":1,"op":"SCMP_CMP_NE"}]},
  {"names":["io_uring_setup","io_uring_enter","io_uring_register"],"action":"SCMP_ACT_ERRNO","errnoRet":1}]}' >"$PROFILE"

# The kernel refuses prctl(PR_SET_SECCOMP): no ban can be loaded.
NOBAN=$(mktemp)
trap 'rm -f "$PROFILE" "$NOBAN"' EXIT
echo '{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[{"names":["prctl"],"action":"SCMP_ACT_ERRNO",
  "errnoRet":1,"args":[{"index":0,"value":22,"op":"SCMP_CMP_EQ"}]}]}' >"$NOBAN"

out=$(docker run --rm --security-opt seccomp="$NOBAN" -v "${ROOT}:/src:ro" "${IMAGE}" bash -c '
useradd -r -M zveltio-ext && cd /tmp &&
setpriv --reuid=zveltio-ext --regid=zveltio-ext --init-groups env -i PATH="$PATH" HOME=/tmp \
  ZVELTIO_ENGINE_UID=4242 ZVELTIO_EXT_RUNNER_SOCKET=/tmp/runner.sock \
  timeout 20 bun /src/packages/engine/src/binary-entry.ts ext-runner' 2>&1 || true)
echo "no ban:  ${out:0:300}"
grep -q "cannot ban sockets for the processes it starts (\[socket-ban\] the kernel refused" <<<"$out" \
  || { echo "FAIL: a runner that cannot load the socket ban did not refuse to start"; exit 1; }

docker run --rm --security-opt seccomp="$PROFILE" -v "${ROOT}:/src:ro" "${IMAGE}" bash -euo pipefail -c '
cd /tmp
useradd -r -M zveltio
useradd -r -M zveltio-ext
mkdir -p /opt/zveltio /run/zveltio-ext/probe /opt/ext
echo "SECRET=hunter2-env-file" > /opt/zveltio/.env
chown -R zveltio:zveltio /opt/zveltio && chmod 600 /opt/zveltio/.env
chown zveltio-ext /run/zveltio-ext/probe
chown zveltio /opt/ext && chmod 755 /opt/ext
export ZVELTIO_EXT_RUNNER_SOCKET=/run/zveltio-ext/probe/runner.sock
E="/src/packages/engine"

as_engine() { setpriv --reuid=zveltio --regid=zveltio --init-groups env -i PATH="$PATH" HOME=/tmp \
  SECRET=hunter2-process-env "$@"; }

setpriv --reuid=zveltio-ext --regid=zveltio-ext --init-groups env -i PATH="$PATH" HOME=/tmp \
  ZVELTIO_ENGINE_UID="$(id -u zveltio)" ZVELTIO_EXT_RUNNER_SOCKET="$ZVELTIO_EXT_RUNNER_SOCKET" \
  bun "$E/src/binary-entry.ts" ext-runner >/tmp/runner.log 2>&1 &
for _ in $(seq 50); do [ -S "$ZVELTIO_EXT_RUNNER_SOCKET" ] && break; sleep 0.1; done

fail=0

out=$(as_engine bun "$E/scripts/ext-runner-isolation.ts" process /opt/zveltio/.env /opt/ext/p)
echo "process: $out"
[ "$(grep -o hunter2 <<<"$out" | wc -l)" -ge 2 ] || { echo "FAIL: process transport should read both secrets (probe broken?)"; fail=1; }
# ADR 0062 probe "security": native code opens a socket under the engine uid.
# AF_UNIX: the profile above refuses every other family to the whole container.
grep -q "\"ffi socket AF_UNIX\":\"REACHED" <<<"$out" \
  || { echo "FAIL: under the engine uid native code opens no socket (probe broken?)"; fail=1; }

# The profile leaves AF_UNIX open, as the unit does; the ban refuses it.
out=$(as_engine PROBE_UNIX="$ZVELTIO_EXT_RUNNER_SOCKET" PROBE_READ=/opt/ext/p/index.mjs bun "$E/scripts/ext-runner-isolation.ts" runner /opt/zveltio/.env /opt/ext/r "$ZVELTIO_EXT_RUNNER_SOCKET")
echo "runner:  $out"
grep -q "\"transport\":\"runner\"" <<<"$out" || { echo "FAIL: runner probe gave no answer"; fail=1; }
grep -q "\"$ZVELTIO_EXT_RUNNER_SOCKET\":\"DENIED EACCES\"" <<<"$out" \
  || { echo "FAIL: the extension opened an AF_UNIX socket (no socket ban)"; fail=1; }
grep -q hunter2 <<<"$out" && { echo "FAIL: runner transport read an engine secret"; fail=1; }
# Native sockets through FFI, and the files of another extension.
grep -qE "\"ffi( socket AF_UNIX)?\":\"DENIED" <<<"$out" || { echo "FAIL: native code opened a socket"; fail=1; }
grep -q "\"REACHED" <<<"$out" && { echo "FAIL: the extension reached what it must not (escapes)"; fail=1; }

# Any uid but the engine is refused: the connection closes before a runtime starts.
out=$(setpriv --reuid=zveltio-ext --regid=zveltio-ext --init-groups env -i PATH="$PATH" HOME=/tmp \
  bun "$E/scripts/ext-runner-isolation.ts" runner /opt/zveltio/.env /tmp/x "$ZVELTIO_EXT_RUNNER_SOCKET" 2>&1 || true)
echo "foreign uid: $out"
grep -q "channel ended" <<<"$out" && grep -q "refused a connection from uid $(id -u zveltio-ext)" /tmp/runner.log \
  || { echo "FAIL: runner served a uid other than the engine"; fail=1; }
cat /tmp/runner.log

[ "$fail" = 0 ] && echo "PASS: ext-runner isolation"
exit "$fail"
'
