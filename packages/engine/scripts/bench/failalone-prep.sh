#!/usr/bin/env bash
# ADR 0062 probe "fail-alone", step 1 (on the VM, as the operator): two trees of
# 4 extensions each: finance/invoicing, probe/plain (a plain collection for the
# data-API load) and the three misbehaving test extensions (probe-bad-ext/).
#   ext-bad-inline  signed as the registry signs (the only way to run inline)
#   ext-bad-worker  engine.isolation "worker", signed with the operator key (level 3)
set -euo pipefail
RUN=/opt/zveltio-run; REPO=/opt/zveltio-bench/zveltio
HERE="$(cd "$(dirname "$0")" && pwd)"
NAMES="finance/invoicing probe/plain probe/loop probe/leak probe/crash"
for v in inline worker; do
  T=$RUN/ext-bad-$v
  sudo rm -rf "$T"; sudo install -d -o liviu "$T"
  # the core-deps layout of the full tree (package.json, node_modules, .deno)
  sudo cp -a $RUN/ext-$v/package.json $RUN/ext-$v/bun.lock $RUN/ext-$v/node_modules "$T"/ 2>/dev/null || true
  sudo install -d -o liviu "$T/finance" "$T/probe"
  sudo cp -a $RUN/ext-$v/finance/invoicing "$T/finance/invoicing"
  for e in plain loop leak crash; do cp -a "$HERE/probe-bad-ext/$e" "$T/probe/$e"; done
  sudo chown -R liviu "$T"
done
for v in inline worker; do for e in plain loop leak crash; do
  bun $REPO/packages/engine/scripts/bench/failalone-integrity.ts $RUN/ext-bad-$v/probe/$e $([ $v = worker ] && echo worker)
done; done
bun $REPO/packages/engine/scripts/bench/small-vps-sign.ts $RUN/bench/operator-key.json $RUN/ext-bad-worker $NAMES >$RUN/bench/operator-bad.line
(cd $REPO && bun scripts/sign-as-registry.ts $RUN/ext-bad-inline $NAMES 2>/dev/null) >$RUN/bench/registry-bad.line
sudo chown -R zveltio:zveltio $RUN/ext-bad-inline $RUN/ext-bad-worker
sudo install -d -o zveltio -g zveltio $RUN/ext-bad-worker/.deno $RUN/ext-bad-inline/.deno
cat $RUN/bench/registry-bad.line $RUN/bench/operator-bad.line
