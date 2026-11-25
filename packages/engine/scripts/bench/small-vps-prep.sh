#!/usr/bin/env bash
# ADR 0062 probe "small VPS", step 1: the two extension trees the states boot from.
#   ext-inline  the 37 declared-model first-party extensions as they are, signed as
#               the registry signs them (the only way a first-party one runs inline)
#   ext-worker  the same with engine.isolation "worker", signed with an operator key
#               (level 3), which runs on the runner
# Key lines go to $RUN/bench/{registry,operator}.line. Run on the VM, as the operator.
set -euo pipefail
RUN=/opt/zveltio-run
REPO=/opt/zveltio-bench/zveltio
SRC=/opt/zveltio-bench/zveltio-extensions
# Asserted in packages/engine/src/tests/harness/ext-first-party-as-worker.test.ts (LOADS).
EXTS="ai auth/scim communications/mail compliance/ro/documents compliance/ro/efactura
compliance/ro/etransport compliance/ro/procurement compliance/ro/saft content/media crm
ecommerce/store finance/accounting finance/banking finance/expenses finance/invoicing
finance/quotes finance/subscriptions forms geospatial/postgis hr/employees hr/leave hr/payroll
hr/time-tracking i18n/translations operations/assets operations/inventory operations/pos
projects/helpdesk projects/management storage/cloud templates/ansvsa templates/helpdesk
templates/inventory templates/invoicing templates/project workflow/approvals workflow/checklists"
sudo install -d -o liviu -m 755 $RUN/bench
for v in inline worker; do
  sudo rm -rf $RUN/ext-$v
  sudo install -d -o zveltio -g zveltio -m 755 $RUN/ext-$v $RUN/ext-$v/.deno
  for e in $EXTS; do
    sudo install -d -o zveltio -g zveltio -m 755 "$RUN/ext-$v/$e"
    (cd "$SRC/$e" && tar --exclude=node_modules --exclude=.zveltio-registry -cf - .) |
      sudo tar -xf - -C "$RUN/ext-$v/$e" --no-same-owner
  done
done
sudo chown -R zveltio:zveltio $RUN/ext-inline $RUN/ext-worker
echo "$EXTS" | wc -w
# worker tree: manifest isolation, then the operator's signature
for e in $EXTS; do
  sudo -u zveltio bun -e "const f='$RUN/ext-worker/$e/manifest.json';const m=JSON.parse(await Bun.file(f).text());m.engine.isolation='worker';await Bun.write(f,JSON.stringify(m))"
done
# signing writes next to the manifest: do it as the owner of the tree, then hand it back
sudo chown -R liviu $RUN/ext-worker $RUN/ext-inline
bun $REPO/packages/engine/scripts/bench/small-vps-sign.ts $RUN/bench/operator-key.json $RUN/ext-worker $EXTS >$RUN/bench/operator.line
bun $REPO/scripts/sign-as-registry.ts $RUN/ext-inline 2>/dev/null >$RUN/bench/registry.line
sudo chown -R zveltio:zveltio $RUN/ext-inline $RUN/ext-worker
echo "$EXTS" | tr -s ' \n' ',' | sed 's/,$//' >$RUN/bench/names
cat $RUN/bench/registry.line $RUN/bench/operator.line
