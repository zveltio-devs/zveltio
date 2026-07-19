#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const EXT = join(import.meta.dir, '..', '..', '..', '..', 'zveltio-extensions');

const ONCLICK_FIXES: [string, string][] = [
  [
    `onclick={() => {m['compliance.ro.efactura.ui.generatexml_inv_id_xml']()}</button>`,
    `onclick={() => generateXML(inv.id)}>{m['compliance.ro.efactura.btn.generateXml']()}</button>`,
  ],
  [
    `onclick={() => {m['search.ui.openconfigmodal_configure_your_first_index']()}</button>`,
    `onclick={() => openConfigModal('')}>{m['search.configureIndex']()}</button>`,
  ],
  [
    `onclick={() => {m['operations.traceability.ui.selected_null_nchide']()}</button>`,
    `onclick={() => (selected = null)}>{m['common.close']()}</button>`,
  ],
  [
    `onclick={() => {m['operations.traceability.ui.shownewform_true_ordin_nou']()}</button>`,
    `onclick={() => (showNewForm = true)}>{m['operations.traceability.production.newOrder']()}</button>`,
  ],
  [
    `onclick={() => {m['operations.traceability.ui.shownewform_false_anuleaz']()}</button>`,
    `onclick={() => (showNewForm = false)}>{m['common.cancel']()}</button>`,
  ],
  [
    `onclick={() => {m['operations.traceability.ui.loadorder_order_id_deschide']()}</button>`,
    `onclick={() => loadOrder(order.id)}>{m['common.open']()}</button>`,
  ],
  [
    `onclick={() => {m['operations.traceability.ui.startorder_selectedorder_id_porne_te_produc_ia']()}</button>`,
    `onclick={() => startOrder(selectedOrder!.id)}>{m['operations.traceability.production.start']()}</button>`,
  ],
  [
    `onclick={() => {m['projects.helpdesk.ui.resolve_activeticket_id_mark_resolved']()}</button>`,
    `onclick={() => resolve(activeTicket!.id)}>{m['projects.helpdesk.btn.resolve']()}</button>`,
  ],
  [
    `onclick={() => {m['content.documents.ui.tab_templates_view_templates']()}</button>`,
    `onclick={() => (tab = 'templates')}>{m['content.documents.btn.viewTemplates']()}</button>`,
  ],
  [
    `onclick={() => {m['compliance.ro.procurement.ui.approveorder_o_id_aprobare']()}</button>`,
    `onclick={() => approveOrder(o.id)}>{m['compliance.ro.procurement.btn.approve']()}</button>`,
  ],
  [
    `onclick={() => {m['compliance.ro.procurement.ui.showordermodal_false_anulare']()}</button>`,
    `onclick={() => (showOrderModal = false)}>{m['common.cancel']()}</button>`,
  ],
  [
    `onclick={() => {m['compliance.ro.procurement.ui.showsuppliermodal_false_anulare']()}</button>`,
    `onclick={() => (showSupplierModal = false)}>{m['common.cancel']()}</button>`,
  ],
  [
    `onclick={() => {m['compliance.ro.documents.ui.filter_all_toate']()}</button>`,
    `onclick={() => (filter = 'all')}>{m['common.filter.all']()}</button>`,
  ],
  [
    `onclick={() => {m['compliance.ro.documents.ui.showcreatemodal_false_anulare']()}</button>`,
    `onclick={() => (showCreateModal = false)}>{m['common.cancel']()}</button>`,
  ],
  [
    `onclick={() => {m['compliance.gdpr.ui.fulfill_r_id_fulfill']()}</button>`,
    `onclick={() => fulfill(r.id)}>{m['compliance.gdpr.btn.fulfill']()}</button>`,
  ],
  [
    `onclick={() => {m['analytics.quality.ui.viewissues_s_id_view']()}</button>`,
    `onclick={() => viewIssues(s.id)}>{m['common.view']()}</button>`,
  ],
];

const MSG: Record<string, { en: string; ro: string }> = {
  'compliance.ro.efactura.btn.generateXml': { en: 'XML', ro: 'XML' },
  'operations.traceability.production.newOrder': { en: 'New order', ro: 'Comandă nouă' },
  'operations.traceability.production.start': { en: 'Start production', ro: 'Pornește producția' },
  'projects.helpdesk.btn.resolve': { en: 'Resolve', ro: 'Rezolvă' },
  'content.documents.btn.viewTemplates': { en: 'View templates', ro: 'Vezi șabloane' },
  'compliance.ro.procurement.btn.approve': { en: 'Approve', ro: 'Aprobă' },
  'compliance.gdpr.btn.fulfill': { en: 'Fulfill', ro: 'Îndeplinește' },
  'common.open': { en: 'Open', ro: 'Deschide' },
  'common.view': { en: 'View', ro: 'Vezi' },
};

const STUDIO = join(import.meta.dir, '..');
const en = JSON.parse(readFileSync(join(STUDIO, 'messages/en.json'), 'utf8')) as Record<
  string,
  string
>;
const ro = JSON.parse(readFileSync(join(STUDIO, 'messages/ro.json'), 'utf8')) as Record<
  string,
  string
>;
for (const [k, v] of Object.entries(MSG)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

function dedupeAtSecondLoading(rel: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  const c = readFileSync(p, 'utf8');
  const re = /\{#if loading\}/g;
  const first = re.exec(c);
  if (!first) return;
  const second = re.exec(c);
  if (!second) return;
  writeFileSync(p, c.slice(0, second.index).trimEnd() + '\n');
  console.log('deduped', rel);
}

for (const rel of [
  'compliance/gdpr/studio/pages/+page.svelte',
  'developer/api-docs/studio/pages/+page.svelte',
  'content/documents/studio/pages/+page.svelte',
  'content/drafts/studio/pages/+page.svelte',
  'analytics/quality/studio/pages/+page.svelte',
  'projects/helpdesk/studio/pages/+page.svelte',
  'workflow/approvals/studio/pages/+page.svelte',
  'geospatial/postgis/studio/pages/+page.svelte',
  'billing/studio/pages/+page.svelte',
])
  dedupeAtSecondLoading(rel);

function walk(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const p of walk(EXT)) {
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of ONCLICK_FIXES) c = c.replaceAll(a, b);
  if (c !== o) {
    writeFileSync(p, c);
    fixed++;
    console.log('fixed', p.replace(EXT + '/', ''));
  }
}

writeFileSync(join(STUDIO, 'messages/en.json'), JSON.stringify(en, null, 2) + '\n');
writeFileSync(join(STUDIO, 'messages/ro.json'), JSON.stringify(ro, null, 2) + '\n');
console.log(`fix-broken-onclick: ${fixed} file(s)`);
