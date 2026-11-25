#!/usr/bin/env bash
# ADR 0062 probe "fail-alone", step 1 (on the VM, as the operator): two trees of
# 4 extensions each: finance/invoicing, probe/plain (a plain collection for the
# data-API load) and the three misbehaving test extensions (probe-bad-ext/).
#   ext-bad-inline  signed as the registry signs (the only way to run inline)
#   ext-bad-worker  engine.isolation "worker", signed with the operator key (level 3)
set -euo pipefail
RUN=/opt/zveltio-run; REPO=/opt/zveltio-bench/zveltio
HERE="$(cd "$(dirname "$0")" && pwd)"
WN="finance/invoicing probe/plain probe/loop probe/leak probe/crash"
# Inline needs a name the marketplace catalog knows (load-phases.ts: a name absent from it is
# community code, which never runs in the engine process): the test code takes the name of a
# first-party template (no actions, collections of its own) and the registry's signature.
declare -A INL=([plain]=analytics/quality [loop]=operations/traceability [leak]=developer/api-docs [crash]=integrations/migrators)
IN="finance/invoicing ${INL[plain]} ${INL[loop]} ${INL[leak]} ${INL[crash]}"
for v in inline worker; do
  T=$RUN/ext-bad-$v
  sudo rm -rf "$T"; sudo install -d -o liviu "$T"
  # the core-deps layout of the full tree (package.json, node_modules, .deno)
  sudo cp -a $RUN/ext-$v/package.json $RUN/ext-$v/bun.lock $RUN/ext-$v/node_modules "$T"/ 2>/dev/null || true
  sudo install -d -o liviu "$T/finance" "$T/probe"
  sudo cp -a $RUN/ext-$v/finance/invoicing "$T/finance/invoicing"
  for e in plain loop leak crash; do
    if [ $v = inline ]; then
      D=$T/${INL[$e]}; mkdir -p "$(dirname "$D")"; cp -a "$HERE/probe-bad-ext/$e" "$D"
      sed -i "s#probe/$e#${INL[$e]}#" "$D/manifest.json" "$D/engine/index.js"
      # collections the worker runs already created are owned by probe/*: a suffix keeps them apart
      for c in "$D"/schema/collections/*.json; do mv "$c" "${c%.json}_i.json"; done
      sed -i -E 's/probe_(notes|loop_log|leak_log|crash_log)/probe_\1_i/g' "$D/manifest.json" "$D"/schema/collections/*.json
    else cp -a "$HERE/probe-bad-ext/$e" "$T/probe/$e"; fi
  done
  sudo chown -R liviu "$T"
done
for v in inline worker; do for e in plain loop leak crash; do
  D=$RUN/ext-bad-$v/$([ $v = inline ] && echo ${INL[$e]} || echo probe/$e)
  bun $REPO/packages/engine/scripts/bench/failalone-integrity.ts $D $([ $v = worker ] && echo worker)
done; done
bun $REPO/packages/engine/scripts/bench/small-vps-sign.ts $RUN/bench/operator-key.json $RUN/ext-bad-worker $WN >$RUN/bench/operator-bad.line
(cd $REPO && bun scripts/sign-as-registry.ts $RUN/ext-bad-inline $IN 2>/dev/null) >$RUN/bench/registry-bad.line
sudo chown -R zveltio:zveltio $RUN/ext-bad-inline $RUN/ext-bad-worker
sudo install -d -o zveltio -g zveltio $RUN/ext-bad-worker/.deno $RUN/ext-bad-inline/.deno
cat $RUN/bench/registry-bad.line $RUN/bench/operator-bad.line
