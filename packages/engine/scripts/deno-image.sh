#!/usr/bin/env bash
# Deno jobs in the shipped image (ADR 0022, ADR 0023). The image is alpine
# (musl) and Deno publishes only a glibc build, so this runs against the image
# itself: deno.ts downloads the pinned Deno inside it and checks both digests,
# `deno --version` runs, and a job runs where production runs it — the image's
# own `zveltio ext-runner`, started as the entrypoint starts it, under an
# extension's uid (no passwd entry, so the runner's DENO_DIR is what lets Deno
# start) and the socket ban, read from outside while the job is held. The job
# answers its host call and is refused the network.
#
#   bash packages/engine/scripts/deno-image.sh <image>
set -euo pipefail

ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${1:?usage: deno-image.sh <image>}"

docker run --rm -i --user 0:0 --entrypoint sh -v "$ENGINE:/e:ro" "$IMG" -s <<'EOF'
set -eu
export EXTENSIONS_DIR="$(mktemp -d)"
deno=$(bun -e 'console.log(await (await import("/e/src/lib/extensions/deno.ts")).ensureDeno())')
"$deno" --version | head -1
chmod -R a+rX "$EXTENSIONS_DIR"
sock=/run/zveltio-ext/runner.sock
env -i PATH="$PATH" NODE_ENV=production ZVELTIO_ENGINE_UID=100 ZVELTIO_EXT_RUNNER_SOCKET="$sock" \
  ZVELTIO_EXT_RUNNER_UID_BASE=200000 EXTENSIONS_DIR="$EXTENSIONS_DIR" \
  setpriv --inh-caps=-all --bounding-set=-all,+setuid,+setgid,+kill -- zveltio ext-runner &
i=0
while [ ! -S "$sock" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
[ -S "$sock" ] || { echo "the image's runner is not listening"; exit 1; }
cat > /tmp/job.ts <<'JOB'
import { runInDeno } from '/e/src/lib/extensions/job-runner.ts';
const src = `export default { j: async (input, host) => {
  try { await fetch('http://1.1.1.1/'); throw new Error('the job reached the network'); }
  catch (e) { if (!/Requires net access/.test(e.message)) throw e; }
  if (await host.collections.read('c', '1') !== input.n + 1) throw new Error('host call lost');
  await new Promise((r) => setTimeout(r, 3000));
} };`;
await runInDeno({
  extName: 'acme/deno-image', deno: process.argv[2], code: new TextEncoder().encode(src), job: 'j',
  input: { n: 1 }, timezone: 'UTC', memoryMb: 64, timeoutSeconds: 20, call: async () => 2,
});
console.log('job ran on the runner');
JOB
cd /tmp
# As the engine: uid 100, the transport production defaults to.
setpriv --reuid=100 --regid=101 --clear-groups --no-new-privs -- \
  env -i PATH="$PATH" NODE_ENV=production ZVELTIO_EXT_RUNNER_SOCKET="$sock" \
  EXTENSIONS_DIR="$EXTENSIONS_DIR" bun /tmp/job.ts "$deno" &
job=$!
st=
for _ in $(seq 1 40); do
  sleep 0.25
  st=$(for p in /proc/[0-9]*; do grep -q '^Name:.*deno' "$p/status" 2>/dev/null && cat "$p/status"; done; true)
  [ -n "$st" ] && break
done
wait "$job"
uid=$(echo "$st" | awk '/^Uid:/{print $2; exit}')
[ -n "$uid" ] && [ "$uid" -ge 200000 ] || { echo "the job ran as uid ${uid:-?}, not an extension's"; exit 1; }
echo "$st" | grep -qE '^Seccomp:[[:space:]]+2' || { echo "the job ran without the socket ban"; exit 1; }
echo "job ran as uid $uid under the socket ban"
EOF
