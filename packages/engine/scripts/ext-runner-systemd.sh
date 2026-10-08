#!/usr/bin/env bash
# Extension runners on a real systemd (RFC extension-runner, step 3b).
#
# Needs root through sudo and systemd as PID 1 — a GitHub ubuntu runner, not a
# container: IPAddressDeny, DynamicUser and polkit are enforced only there (a
# user manager accepts IPAddressDeny and ignores it). Builds the binary,
# installs the units with `zveltio ext-runner setup`, and plays the engine as
# its own user. Asserts:
#   - over `process` (today: the engine's uid) the probe reads the engine's .env
#     and environment and reaches the network — the probe works;
#   - an extension in its runner reads neither secret and reaches no address;
#   - the operator's IPAddressAllow opens egress for that extension only;
#   - two extensions run under two different uids, neither the engine's, and
#     one cannot write into the other's runner directory;
#   - the engine user may start its runners through polkit and no other unit.
#
#   bash packages/engine/scripts/ext-runner-systemd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
E="${ROOT}/packages/engine"
DIR=/opt/zveltio-ci
URL="${PROBE_PUBLIC_URL:-https://example.com}"
fail=0
check() { if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }

# ── install, as install.sh does ───────────────────────────────────────────────
command -v pkaction >/dev/null || sudo apt-get install -y -qq polkitd >/dev/null
id -u zveltio &>/dev/null || sudo useradd -r -M -s /bin/false zveltio
bun build --compile "${E}/src/binary-entry.ts" --outfile /tmp/zveltio-ci-bin >/dev/null
bun build --target bun "${E}/scripts/ext-runner-isolation.ts" --outfile /tmp/zveltio-ci-probe.mjs >/dev/null
sudo mkdir -p "${DIR}/extensions"
sudo install -m 755 /tmp/zveltio-ci-bin "${DIR}/zveltio"
sudo install -m 644 /tmp/zveltio-ci-probe.mjs "${DIR}/probe.mjs"
echo "SECRET=hunter2-env-file" | sudo tee "${DIR}/.env" >/dev/null
sudo chown -R zveltio:zveltio "${DIR}"
sudo chmod 600 "${DIR}/.env"
sudo "${DIR}/zveltio" ext-runner setup --engine-user zveltio --dir "${DIR}"
sudo systemctl daemon-reload

probe() { # <transport> <ext dir> [target] — env PROBE_URL / PROBE_WRITE pass through
  local t="$1" d="$2" target="${3:-}"
  sudo -u zveltio env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
    SECRET=hunter2-process-env BUN_BE_BUN=1 PROBE_URL="${PROBE_URL:-}" PROBE_WRITE="${PROBE_WRITE:-}" \
    "${DIR}/zveltio" "${DIR}/probe.mjs" "$t" "${DIR}/.env" "${DIR}/extensions/$d" $target
}

# ── today: the engine's uid ───────────────────────────────────────────────────
out=$(PROBE_URL="$URL" probe process p)
echo "process: ${out:0:200}"
check "process transport reads both secrets (probe works)" '[ "$(grep -o hunter2 <<<"$out" | wc -l)" -ge 2 ]'
check "process transport reaches ${URL} (network is there)" 'grep -q "\"fetch\":\"HTTP 200\"" <<<"$out"'

# ── extension A in its runner ─────────────────────────────────────────────────
out=$(PROBE_URL="$URL" probe managed a acme/probe-a)
echo "runner A: $out"
check "runner answered" 'grep -q "\"transport\":\"managed\"" <<<"$out"'
check "runner reads no engine secret" '! grep -q hunter2 <<<"$out"'
check "runner reaches no address" 'grep -q "\"fetch\":\"DENIED" <<<"$out"'

INST_A=$(ls /run/zveltio-ext)
UNIT_A="zveltio-ext-runner@${INST_A}.service"

# ── extension B: another uid, cannot touch A ──────────────────────────────────
out=$(PROBE_WRITE="/run/zveltio-ext/${INST_A}/planted.sock" probe managed b acme/probe-b)
echo "runner B: $out"
check "B cannot write into A's runner directory" 'grep -q "\"write\":\"DENIED" <<<"$out"'
INST_B=$(ls /run/zveltio-ext | grep -vx "${INST_A}")
uid_of() { ps -o uid= -p "$(systemctl show -p MainPID --value "zveltio-ext-runner@$1.service")" | tr -d ' '; }
UA=$(uid_of "$INST_A"); UB=$(uid_of "$INST_B"); UE=$(id -u zveltio)
echo "uids: A=$UA B=$UB engine=$UE"
check "A and B run under different uids, neither the engine's" '[ "$UA" != "$UB" ] && [ "$UA" != "$UE" ] && [ "$UB" != "$UE" ] && [ "$UA" != 0 ]'

# ── the operator opens egress for A only ──────────────────────────────────────
sudo systemctl set-property --runtime "$UNIT_A" IPAddressAllow=any
out=$(PROBE_URL="$URL" probe managed a acme/probe-a)
echo "runner A allowed: $out"
check "IPAddressAllow opens A" 'grep -q "\"fetch\":\"HTTP 200\"" <<<"$out"'
out=$(PROBE_URL="$URL" probe managed b acme/probe-b)
check "B stays closed" 'grep -q "\"fetch\":\"DENIED" <<<"$out"'

# ── polkit: runners yes, anything else no ─────────────────────────────────────
err=$(sudo -u zveltio systemctl stop --no-ask-password "$UNIT_A" 2>&1) && echo "engine stopped A" || { echo "$err"; fail=1; }
err=$(sudo -u zveltio systemctl restart --no-ask-password cron.service 2>&1 || true)
check "engine user may not manage other units" 'grep -qiE "access denied|authentication" <<<"$err"'

sudo systemctl stop 'zveltio-ext-runner@*' 2>/dev/null || true
[ "$fail" = 0 ] && echo "PASS: ext-runner on systemd"
exit "$fail"
