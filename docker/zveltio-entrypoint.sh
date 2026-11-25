#!/bin/sh
# The image's entrypoint. As the image's user (uid 100: the release compose,
# Helm) it is the binary, unchanged. As root — the Dockerfile's `standalone`
# stage, which fly.toml, railway.json and render.yaml build, or
# `docker run --user 0:0` — `start` gets the extension runner in this container
# (RFC extension-runner, step 9b): the runner as root with only
# CAP_SETUID, CAP_SETGID and CAP_KILL and none of the container's environment,
# every extension under a uid of its own, and the engine dropped to 100:101.
set -eu
BIN=/usr/local/bin/zveltio
if [ "$(id -u)" != 0 ] || [ "${1:-start}" != start ]; then exec "$BIN" "$@"; fi

# What this setup needs: CHOWN, DAC_OVERRIDE and FOWNER for /data, SETPCAP for
# the bounding set, and SETUID, SETGID and KILL for the runner and the drop to
# 100:101 (bits 0, 1, 3, 8, 7, 6, 5). A platform that drops them (`docker run
# --cap-drop ALL`, a PaaS with a locked-down profile) fails at the first chown
# with no word about extensions. Exit with the cause instead of running on: the
# engine cannot drop to 100 without SETUID/SETGID, and as root with nothing it
# would run a worker extension in no isolation at all (ADR 0062, F21). The way
# through on such a platform is the image's own user (`--user 100:101`, the
# release compose, Helm): no runner, worker extensions refused, first-party
# inline extensions unaffected.
need=$((0x1eb))
eff=$(awk '/^CapEff:/{print $2}' /proc/self/status 2>/dev/null || true)
if [ -n "$eff" ] && [ $((0x$eff & need)) -ne $need ]; then
  echo "[entrypoint] started as root without the capabilities the extension runner needs (CapEff $eff; required: CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID, SETPCAP). Grant them (docker: --cap-add for each; compose: cap_add) or start the image as its own user (--user 100:101): then no worker extension runs (they are refused, never run unisolated) and inline first-party extensions work." >&2
  exit 1
fi

# The extensions' uids share this filesystem. /data is the engine's (a PaaS
# volume arrives root's; a container that ran as root left root's files): they
# may traverse it to reach the Deno in /data/extensions/.deno and nothing else
# in it — not each other's files (ADR 0062, F15; the engine closes the
# directory again before every spawn, closeExtensionsDir).
[ "$(stat -c %u /data)" = 100 ] || chown -R 100:101 /data
mkdir -p /data/extensions /data/storage
chown 100:101 /data/extensions /data/storage
chmod 0711 /data /data/extensions
find /data -mindepth 1 -maxdepth 1 ! -name extensions ! -type l -exec chmod go-rwx {} +
find /data/extensions -mindepth 1 -maxdepth 1 ! -name .deno ! -type l -exec chmod go-rwx {} +
# /tmp is theirs too: the engine's temporary files go where they cannot look.
rm -rf /tmp/zveltio-*  # a restarted container keeps the last run's
tmp=$(mktemp -d /tmp/zveltio-engine.XXXXXX)
chown 100:101 "$tmp"

# An external runner (ZVELTIO_EXT_RUNNER_SOCKET set) is used as it is.
if [ -z "${ZVELTIO_EXT_RUNNER_SOCKET:-}" ]; then
  sock=/run/zveltio-ext/runner.sock
  rm -f "$sock"
  # Restarted if it dies: the engine refuses extensions while it is gone.
  env -i PATH="$PATH" NODE_ENV="${NODE_ENV:-production}" ZVELTIO_ENGINE_UID=100 \
    ZVELTIO_EXT_RUNNER_SOCKET="$sock" \
    ZVELTIO_EXT_RUNNER_UID_BASE="${ZVELTIO_EXT_RUNNER_UID_BASE:-200000}" \
    ${ZVELTIO_DENO_PATH:+"ZVELTIO_DENO_PATH=$ZVELTIO_DENO_PATH"} \
    ${EXTENSIONS_DIR:+"EXTENSIONS_DIR=$EXTENSIONS_DIR"} \
    setpriv --inh-caps=-all --bounding-set=-all,+setuid,+setgid,+kill -- \
    sh -c "while :; do $BIN ext-runner; sleep 5; done" &
  i=0
  while [ ! -S "$sock" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  [ -S "$sock" ] || echo "[entrypoint] the extension runner is not listening; third-party extensions will be refused" >&2
  export ZVELTIO_EXT_RUNNER_SOCKET="$sock"
  export ZVELTIO_EXT_TRANSPORT="${ZVELTIO_EXT_TRANSPORT:-runner}"
fi

# tini is PID 1, under the engine's uid: it forwards signals to the engine and
# reaps orphans — the extension processes of a runner that died — which the
# engine would leave as zombies. Reaping needs no privilege.
export HOME=/home/zveltio TMPDIR="$tmp"
exec setpriv --reuid=100 --regid=101 --clear-groups --inh-caps=-all --bounding-set=-all \
  --no-new-privs -- /sbin/tini -- "$BIN" "$@"
