#!/usr/bin/env bash
# Extension runners on a real systemd (RFC extension-runner, step 3b).
#
# Needs root through sudo and systemd as PID 1 — a GitHub ubuntu runner, not a
# container: IPAddressDeny, DynamicUser and polkit are enforced only there (a
# user manager accepts IPAddressDeny and ignores it). Builds the binary,
# installs the units with `zveltio ext-runner setup`, and plays the engine as
# its own user. Asserts:
#   - over `process` (today: the engine's uid) the probe reads the engine's .env
#     and environment and opens a socket to the network — the probe works — and
#     its `fetch` is refused by the runtime (ADR 0022: no egress for routes);
#   - an extension in its runner reads neither secret and reaches no address,
#     not even over a raw socket (IPAddressDeny=any, no operator override),
#     nor the host's D-Bus socket nor an abstract socket on the host
#     (InaccessiblePaths, PrivateNetwork: AF_UNIX stays open to the runner);
#     the unit bans every socket family but AF_UNIX (seccomp, ADR 0023), and
#     the socket ban the runner loads into each process refuses AF_UNIX too
#     (EACCES at socket(), where the unit alone gives ECONNREFUSED) — it
#     answered, so its start check saw every family refused;
#   - two extensions run under two different uids, neither the engine's, and
#     one cannot write into the other's runner directory;
#   - the engine user may start its runners through polkit and no other unit;
#   - an edge function (step 5; by default, ADR 0058 d2) runs in the
#     `edge` instance: no address, a uid per invocation (two held at once get
#     two) that is not the engine's and cannot
#     read the engine's .env (measured from outside while the invocation lives);
#   - its egress goes through the engine: a listed host answers, an unlisted
#     host and a private address are refused;
#   - a Deno job (ADR 0023 decision 2) runs in its extension's instance, under
#     the unit's uid and seccomp (read from outside while it is held), finds
#     the Deno the engine downloaded through the unit's EXTENSIONS_DIR, reaches
#     its host only through the engine, and dies past its memoryMb.
#
#   bash packages/engine/scripts/ext-runner-systemd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
E="${ROOT}/packages/engine"
# The engine user cannot read the checkout: every `sudo -u zveltio` keeps the
# working directory, and posix_spawn fails with EACCES from an unreadable one.
cd /tmp
DIR=/opt/zveltio-ci
URL="${PROBE_PUBLIC_URL:-https://example.com}"
fail=0
check() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }

# ── install, as install.sh does ───────────────────────────────────────────────
command -v pkaction >/dev/null || sudo apt-get install -y -qq polkitd >/dev/null
id -u zveltio &>/dev/null || sudo useradd -r -M -s /bin/false zveltio
bun build --compile "${E}/src/binary-entry.ts" --outfile /tmp/zveltio-ci-bin >/dev/null
bun build --target bun "${E}/scripts/ext-runner-isolation.ts" --outfile /tmp/zveltio-ci-probe.mjs >/dev/null
bun build --target bun "${E}/scripts/edge-runner-isolation.ts" --outfile /tmp/zveltio-ci-edge-probe.mjs >/dev/null
bun build --target bun "${E}/scripts/job-runner-isolation.ts" --outfile /tmp/zveltio-ci-job-probe.mjs >/dev/null
# Explicit mode: the engine refuses a Deno under a directory others can write,
# and this runner's sudo leaves mkdir at 777.
sudo install -d -m 755 "${DIR}" "${DIR}/extensions"
sudo install -m 755 /tmp/zveltio-ci-bin "${DIR}/zveltio"
sudo install -m 644 /tmp/zveltio-ci-probe.mjs "${DIR}/probe.mjs"
sudo install -m 644 /tmp/zveltio-ci-edge-probe.mjs "${DIR}/edge-probe.mjs"
sudo install -m 644 /tmp/zveltio-ci-job-probe.mjs "${DIR}/job-probe.mjs"
echo "SECRET=hunter2-env-file" | sudo tee "${DIR}/.env" >/dev/null
sudo chown -R zveltio:zveltio "${DIR}"
sudo chmod 600 "${DIR}/.env"
sudo "${DIR}/zveltio" ext-runner setup --engine-user zveltio --dir "${DIR}"
sudo systemctl daemon-reload

probe() { # <transport> <ext dir> [target] — env PROBE_URL / PROBE_WRITE pass through
  local t="$1" d="$2" target="${3:-}"
  sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
    SECRET=hunter2-process-env BUN_BE_BUN=1 PROBE_URL="${PROBE_URL:-}" PROBE_WRITE="${PROBE_WRITE:-}" \
    DATABASE_URL=postgres://zveltio:hunter2-db@127.0.0.1:5432/zveltio BETTER_AUTH_SECRET=hunter2-auth \
    FIELD_ENCRYPTION_KEY=hunter2-fek \
    PROBE_UNIX="${PROBE_UNIX:-}" PROBE_TCP="${PROBE_TCP:-}" PROBE_READ="${PROBE_READ:-}" \
    "${DIR}/zveltio" "${DIR}/probe.mjs" "$t" "${DIR}/.env" "${DIR}/extensions/$d" $target
}

# Host AF_UNIX sockets: AF_UNIX stays open in the unit (ADR 0023), so only
# InaccessiblePaths hides D-Bus's path socket and only PrivateNetwork hides an
# abstract one (this listener, in the host's network namespace).
DBUS=/run/dbus/system_bus_socket
[ -S "$DBUS" ] || { echo "FAIL: no $DBUS on this host to probe"; fail=1; }
bun -e 'require("node:net").createServer((c) => c.end()).listen("\0zveltio-ci-abstract")' &
abstract_pid=$!
trap 'kill "$abstract_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do grep -q '@zveltio-ci-abstract' /proc/net/unix && break; sleep 0.1; done
# A Postgres where an install has one, over TCP and its unix socket (a listener
# stands in: the probe measures the socket, not the protocol). The engine's
# user reaches both; a runner neither (IPAddressDeny, InaccessiblePaths, ban).
PGSOCK=/run/postgresql/.s.PGSQL.5432
sudo install -d -m 755 /run/postgresql
sudo "$(command -v bun)" -e 'const net = require("node:net"); const fs = require("node:fs");
  net.createServer((c) => c.end()).listen(5432, "127.0.0.1");
  net.createServer((c) => c.end()).listen(process.argv[1], () => fs.chmodSync(process.argv[1], 0o777))' "$PGSOCK" &
pg_pid=$!
trap 'kill "$abstract_pid" 2>/dev/null || true; sudo kill "$pg_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -S "$PGSOCK" ] && break; sleep 0.1; done
export PROBE_UNIX="$DBUS @zveltio-ci-abstract $PGSOCK" PROBE_TCP=127.0.0.1:5432

# ── today: the engine's uid ───────────────────────────────────────────────────
out=$(PROBE_URL="$URL" probe process p)
echo "process: ${out:0:200}"
check "process transport reads both secrets (probe works)" '[ "$(grep -o hunter2 <<<"$out" | wc -l)" -ge 2 ]'
check "process transport opens a socket to ${URL} (network is there)" 'grep -q "\"net\":\"CONNECTED\"" <<<"$out"'
check "process transport: the runtime refuses fetch" 'grep -q "\"fetch\":\"DENIED" <<<"$out"'
check "process transport reaches the host's D-Bus and abstract sockets (probe works)" \
  'grep -q "\"$DBUS\":\"CONNECTED\"" <<<"$out" && grep -q "\"@zveltio-ci-abstract\":\"CONNECTED\"" <<<"$out"'
# ADR 0062 probe "security": the controls for the runner's refusals below.
check "process transport reaches Postgres over TCP and its socket (probe works)" \
  'grep -q "\"tcp 127.0.0.1:5432\":\"REACHED" <<<"$out" && grep -q "\"$PGSOCK\":\"CONNECTED\"" <<<"$out"'
check "process transport: native code (FFI) and a child open sockets (probe works)" \
  'grep -q "\"ffi socket AF_INET\":\"REACHED" <<<"$out" && grep -q "\"child net\":\"REACHED" <<<"$out"'
check "process transport reads the engine's DATABASE_URL, auth secret and field key (probe works)" \
  'grep -q hunter2-db <<<"$out" && grep -q hunter2-auth <<<"$out" && grep -q hunter2-fek <<<"$out"'

# ── extension A in its runner ─────────────────────────────────────────────────
out=$(PROBE_URL="$URL" PROBE_READ="${DIR}/extensions/p/index.mjs" probe managed a acme/probe-a)
echo "runner A: $out"
check "runner answered" 'grep -q "\"transport\":\"managed\"" <<<"$out"'
check "runner reads no engine secret" '! grep -q hunter2 <<<"$out"'
check "runner reaches no address, raw socket included" 'grep -q "\"net\":\"DENIED" <<<"$out"'
check "runner cannot reach the host's D-Bus socket (InaccessiblePaths)" 'grep -q "\"$DBUS\":\"DENIED" <<<"$out"'
check "runner cannot reach a host abstract socket (PrivateNetwork)" \
  'grep -q "\"@zveltio-ci-abstract\":\"DENIED" <<<"$out"'
check "runner's process opens no AF_UNIX socket (socket ban, owner 2026-11-24)" \
  'grep -q "\"@zveltio-ci-abstract\":\"DENIED EACCES\"" <<<"$out"'
# ADR 0062 probe "security".
check "runner reaches no Postgres, over TCP or its socket" \
  'grep -q "\"tcp 127.0.0.1:5432\":\"DENIED" <<<"$out" && grep -q "\"$PGSOCK\":\"DENIED" <<<"$out"'
check "runner: native code (FFI socket(2)) and a child open no socket" \
  '{ grep -q "\"ffi\":\"DENIED" <<<"$out" ||
     { grep -q "\"ffi socket AF_INET\":\"DENIED" <<<"$out" && grep -q "\"ffi socket AF_UNIX\":\"DENIED" <<<"$out"; }; } &&
   grep -q "\"child net\":\"DENIED" <<<"$out"'
check "runner cannot read another extension's files" '! grep -q "\"read [^\"]*\":\"REACHED" <<<"$out"'
check "runner reaches nothing past its boundary (escapes)" '! grep -q "\"REACHED" <<<"$out"'

INST_A=$(ls /run/zveltio-ext)
UNIT_A="zveltio-ext-runner@${INST_A}.service"
check "runner unit bans sockets but AF_UNIX, under seccomp" \
  '[ "$(systemctl show -p RestrictAddressFamilies --value "$UNIT_A")" = AF_UNIX ] &&
   sudo grep -q "^Seccomp:[[:space:]]*2" "/proc/$(systemctl show -p MainPID --value "$UNIT_A")/status"'
# ADR 0062 F20: read from the unit's live cgroup, what the kernel enforces.
CG_A="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$UNIT_A")"
check "runner unit caps its CPU at 20% of a core, weight 10 (ADR 0062 F20)" \
  '[ "$(cat "$CG_A/cpu.max")" = "20000 100000" ] && [ "$(cat "$CG_A/cpu.weight")" = 10 ]'

# ── extension B: another uid, cannot touch A ──────────────────────────────────
out=$(PROBE_WRITE="/run/zveltio-ext/${INST_A}/planted.sock" probe managed b acme/probe-b)
echo "runner B: $out"
check "B cannot write into A's runner directory" 'grep -q "\"write\":\"DENIED" <<<"$out"'
INST_B=$(ls /run/zveltio-ext | grep -vx "${INST_A}")
uid_of() { ps -o uid= -p "$(systemctl show -p MainPID --value "zveltio-ext-runner@$1.service")" | tr -d ' '; }
UA=$(uid_of "$INST_A"); UB=$(uid_of "$INST_B"); UE=$(id -u zveltio)
echo "uids: A=$UA B=$UB engine=$UE"
check "A and B run under different uids, neither the engine's" '[ "$UA" != "$UB" ] && [ "$UA" != "$UE" ] && [ "$UB" != "$UE" ] && [ "$UA" != 0 ]'

# ── polkit: runners yes, anything else no ─────────────────────────────────────
err=$(sudo -u zveltio systemctl stop --no-ask-password "$UNIT_A" 2>&1) && echo "engine stopped A" || { echo "$err"; fail=1; }
err=$(sudo -u zveltio systemctl restart --no-ask-password cron.service 2>&1 || true)
check "engine user may not manage other units" 'grep -qiE "access denied|authentication" <<<"$err"'

# ── edge functions: the `edge` instance, started by the engine on first use ───
# The process-transport half of this probe is in ext-runner-compose.sh: run by
# a compiled binary as `bun`, a local spawn would start an engine instead.
# Held for 10 s, so the invocation's uid is read from outside while it lives:
# the JS lockdown leaves the function itself no way to the filesystem. No
# NODE_ENV, no ZVELTIO_EDGE_TRANSPORT and no egress: a hand-started engine's
# function still goes to the runner (ADR 0058 d2).
edge_out=$(mktemp); edge_out2=$(mktemp)
edge_run() {
  sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
    BUN_BE_BUN=1 PROBE_URL="$URL" PROBE_HOLD_MS=10000 \
    "${DIR}/zveltio" "${DIR}/edge-probe.mjs"
}
# Two invocations held at once: each must get a uid of its own (ADR 0058).
edge_run >"$edge_out" 2>&1 &
edge_pid=$!
edge_run >"$edge_out2" 2>&1 &
edge_pid2=$!
# Polled: the engine starts the instance on first use. The runner itself is
# root; the invocations run under uids from 400000 up.
UEDGES=
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  CG=$(systemctl show -p ControlGroup --value zveltio-ext-runner@edge.service 2>/dev/null || true)
  [ -n "$CG" ] || continue
  UEDGES=$(for p in $(cat "/sys/fs/cgroup${CG}/cgroup.procs" 2>/dev/null || true); do
    ps -o uid= -p "$p" 2>/dev/null || true
  done | tr -d ' ' | awk '$1 >= 400000 && $1 < 465536' | sort -u | tr '\n' ' ')
  [ "$(wc -w <<<"$UEDGES")" -ge 2 ] && break
done
UEDGE=$(awk '{print $1}' <<<"$UEDGES")
[ -n "$UEDGES" ] || sudo journalctl -u zveltio-ext-runner@edge.service -n 40 --no-pager -o cat || true
check "two held edge invocations run under two uids of their own" \
  '[ "$(wc -w <<<"$UEDGES")" -ge 2 ] && [ "$UEDGE" != "$UE" ]'
check "the edge runner holds only CAP_SETUID, CAP_SETGID and CAP_KILL" \
  '[ "$(systemctl show -p CapabilityBoundingSet --value zveltio-ext-runner@edge.service)" = "cap_kill cap_setgid cap_setuid" ]'
check "the .env holds the secret (probe control)" 'sudo cat "${DIR}/.env" | grep -q hunter2'
check "edge function's uid reads no engine secret" \
  '[ -n "$UEDGE" ] && ! sudo setpriv --reuid="$UEDGE" --regid="$UEDGE" --clear-groups cat "${DIR}/.env" 2>/dev/null | grep -q hunter2'
wait "$edge_pid" || true
wait "$edge_pid2" || true
out=$(cat "$edge_out"); out2=$(cat "$edge_out2"); rm -f "$edge_out" "$edge_out2"
echo "edge runner: $out (uids ${UEDGES:-?})"
check "edge runner answered" 'grep -q "\"transport\":\"runner\"" <<<"$out" && grep -q "\"transport\":\"runner\"" <<<"$out2"'
check "edge function reaches no address" 'grep -q "\"fetch\":\"DENIED" <<<"$out"'
check "edge instance has room for concurrent invocations" \
  '[ "$(systemctl show -p TasksMax --value zveltio-ext-runner@edge.service)" = 512 ]'
check "edge instance shares one core among its invocations" \
  '[ "$(systemctl show -p CPUQuotaPerSecUSec --value zveltio-ext-runner@edge.service)" = 1s ]'

# ── edge egress: the instance has no address, the engine fetches for it ───────
# Same three cases as ext-runner-compose.sh, here behind IPAddressDeny: a listed
# host answers only through the engine's bridge.
HOST=$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$URL")
egress() { # <url> <egress list>
  sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp BUN_BE_BUN=1 \
    PROBE_URL="$1" PROBE_EGRESS="$2" ZVELTIO_EDGE_TRANSPORT=runner \
    "${DIR}/zveltio" "${DIR}/edge-probe.mjs" 2>&1 || true
}
out=$(egress "$URL" "$HOST")
echo "edge egress listed:   ${out:0:300}"
check "edge egress: a listed host is reached through the engine" 'grep -q "\"fetch\":\"HTTP" <<<"$out"'
out=$(egress "http://example.org/" "$HOST")
echo "edge egress unlisted: ${out:0:300}"
check "edge egress: an unlisted host is refused" 'grep -q "is not in this function" <<<"$out"'
out=$(egress "http://169.254.169.254/latest/meta-data/" "$HOST 169.254.169.254")
echo "edge egress private:  ${out:0:300}"
check "edge egress: a private address is refused" 'grep -q "internal/private address blocked" <<<"$out"'

# ── Deno jobs: the extension's own instance ───────────────────────────────────
job() { # env PROBE_* pass through; the engine downloads Deno on first use
  sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp BUN_BE_BUN=1 \
    EXTENSIONS_DIR="${DIR}/extensions" ZVELTIO_EXT_TRANSPORT=runner PROBE_EXT=acme/job-probe \
    PROBE_URL="${PROBE_URL:-}" PROBE_EGRESS="$HOST" PROBE_HOLD_MS="${PROBE_HOLD_MS:-0}" \
    PROBE_JOB="${PROBE_JOB:-hold}" "${DIR}/zveltio" "${DIR}/job-probe.mjs" 2>&1 || true
}
job >/dev/null
job_out=$(mktemp)
PROBE_URL="$URL" PROBE_HOLD_MS=8000 job >"$job_out" &
job_pid=$!
JSTAT=
for _ in $(seq 1 30); do
  sleep 0.5
  for p in $(pgrep -x deno || true); do JSTAT=$(sudo cat "/proc/$p/status" 2>/dev/null || true); done
  [ -n "$JSTAT" ] && break
done
UJ=$(awk '/^Uid:/{print $2; exit}' <<<"$JSTAT")
check "Deno job runs under a uid of its own" '[ -n "$UJ" ] && [ "$UJ" != "$UE" ] && [ "$UJ" != 0 ]'
check "Deno job runs under the unit's seccomp" 'grep -qE "^Seccomp:[[:space:]]+2" <<<"$JSTAT"'
check "Deno job's uid reads no engine secret" \
  '[ -n "$UJ" ] && ! sudo setpriv --reuid="$UJ" --regid="$UJ" --clear-groups cat "${DIR}/.env" 2>/dev/null | grep -q hunter2'
wait "$job_pid" || true
out=$(cat "$job_out"); rm -f "$job_out"
echo "job: ${out: -400} (uid ${UJ:-?})"
check "Deno job reaches its host through the engine" 'grep -q "\"fetch\":\"HTTP" <<<"$out"'
out=$(PROBE_JOB=alloc job)
echo "job mem: ${out: -400}"
check "Deno job past its memoryMb is killed by the runner's watchdog" \
  'grep -q "exceeded the memory limit of 64 MB" <<<"$out"'

sudo systemctl stop 'zveltio-ext-runner@*' 2>/dev/null || true
[ "$fail" = 0 ] && echo "PASS: ext-runner on systemd"
exit "$fail"
