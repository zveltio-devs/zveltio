#!/usr/bin/env bash
# Deno jobs in the shipped image (ADR 0022, ADR 0023). The image is alpine
# (musl) and Deno publishes only a glibc build, so this runs against the image
# itself: deno.ts downloads the pinned Deno inside it and checks both digests,
# `deno --version` runs, and a job runs through the real runner (runInDeno)
# as the engine's uid under the socket ban, answers its host call, and is
# refused the network. Not an extension's uid yet: one without a passwd entry
# and no HOME leaves Deno no cache directory, which the runner must give it
# (DENO_DIR) when Deno jobs move there.
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
bun -e 'await Bun.write("/tmp/ban.bpf", (await import("/e/src/lib/socket-ban.ts")).socketBanFilter())'
chmod -R a+rX "$EXTENSIONS_DIR"
cat > /tmp/job.ts <<'JOB'
import { runInDeno } from '/e/src/lib/extensions/job-runner.ts';
const src = `export default { j: async (input, host) => {
  try { await fetch('http://1.1.1.1/'); throw new Error('the job reached the network'); }
  catch (e) { if (!/Requires net access/.test(e.message)) throw e; }
  if (await host.collections.read('c', '1') !== input.n + 1) throw new Error('host call lost');
} };`;
await runInDeno({
  deno: process.argv[2], code: new TextEncoder().encode(src), job: 'j', input: { n: 1 },
  timezone: 'UTC', memoryMb: 64, timeoutSeconds: 20, call: async () => 2,
});
console.log('job ran under the socket ban');
JOB
cd /tmp
setpriv --reuid=100 --regid=101 --clear-groups --no-new-privs --seccomp-filter=/tmp/ban.bpf -- \
  bun /tmp/job.ts "$deno"
EOF
