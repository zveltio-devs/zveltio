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

# The extensions' uids share this filesystem. /data is the engine's (a PaaS
# volume arrives root's; a container that ran as root left root's files): they
# may traverse it to read /data/extensions and nothing else in it.
[ "$(stat -c %u /data)" = 100 ] || chown -R 100:101 /data
mkdir -p /data/extensions /data/storage
chown 100:101 /data/extensions /data/storage
chmod 0711 /data
chmod 0755 /data/extensions
find /data -mindepth 1 -maxdepth 1 ! -name extensions ! -type l -exec chmod go-rwx {} +
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
    setpriv --inh-caps=-all --bounding-set=-all,+setuid,+setgid,+kill -- \
    sh -c "while :; do $BIN ext-runner; sleep 5; done" &
  i=0
  while [ ! -S "$sock" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  [ -S "$sock" ] || echo "[entrypoint] the extension runner is not listening; third-party extensions will be refused" >&2
  export ZVELTIO_EXT_RUNNER_SOCKET="$sock"
  export ZVELTIO_EXT_TRANSPORT="${ZVELTIO_EXT_TRANSPORT:-runner}"
fi

# ponytail: the engine becomes PID 1 and does not reap orphans; a runner that
# dies leaves its extensions' zombies until the container restarts.
export HOME=/home/zveltio TMPDIR="$tmp"
exec setpriv --reuid=100 --regid=101 --clear-groups --inh-caps=-all --bounding-set=-all \
  --no-new-privs -- "$BIN" "$@"
