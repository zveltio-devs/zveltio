#!/usr/bin/env bun
/** Pass 3: remaining strings, CRM/traceability subroutes, media shell */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

function add(k: string, e: string, r: string) {
  en[k] = e;
  ro[k] = r;
}

const NEW_KEYS: [string, string, string][] = [
  ['crm.organizations.count', '{count} organizations', '{count} organizații'],
  ['crm.transactions.count', '{count} transactions', '{count} tranzacții'],
  ['compliance.ro.procurement.empty.orders', 'No purchase orders yet.', 'Nu există comenzi de achiziție.'],
  ['compliance.ro.procurement.empty.suppliers', 'No suppliers registered yet.', 'Nu există furnizori înregistrați.'],
  ['compliance.ro.procurement.empty.budget', 'No budget lines yet.', 'Nu există linii bugetare.'],
  ['compliance.ro.documents.ui.parties', 'Parties involved', 'Părți implicate'],
  ['compliance.ro.documents.btn.create', 'Create', 'Creare'],
  ['compliance.ro.procurement.col.number', 'Number', 'Număr'],
  ['compliance.ro.procurement.col.date', 'Date', 'Dată'],
  ['compliance.ro.procurement.col.description', 'Description', 'Descriere'],
  ['compliance.ro.procurement.btn.createOrderModal', 'Create order', 'Creare comandă'],
  ['compliance.ro.procurement.btn.recordReception', 'Record reception', 'Înregistrare'],
  ['content.documents.variablesCount', '{n} variable(s)', '{n} variabilă(e)'],
  ['content.media.confirm.deleteFolderTitle', 'Delete folder', 'Șterge folder'],
  ['content.media.confirm.deleteFolderMsg', 'Delete this folder?', 'Ștergi acest folder?'],
  ['content.media.allFiles', 'All Files', 'Toate fișierele'],
  ['geospatial.postgis.resultsLine', '{n} results · {d} m away', '{n} rezultate · {d} m distanță'],
  ['workflow.approvals.tab.workflowsLabel', 'Workflows', 'Fluxuri'],
];

for (const [k, e, r] of NEW_KEYS) add(k, e, r);

function patch(rel: string, reps: [string, string][]) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of reps) c = c.split(a).join(b);
  if (c !== o) {
    writeFileSync(p, c);
    console.log('patched', rel);
  }
}

function ensureImports(c: string): string {
  if (!c.includes("from '$lib/i18n")) {
    c = c.replace(/<script lang="ts">\n/, "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n");
  }
  if (!c.includes('ExtensionPageShell')) {
    c = c.replace(
      /<script lang="ts">\n/,
      "<script lang=\"ts\">\n  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';\n",
    );
  }
  return c;
}

/** Wrap CRM subpage: strip header block, use shell with actions */
function wrapCrmSub(rel: string, titleKey: string, subtitleExpr: string, actionHtml: string) {
  const p = join(EXT, rel);
  if (!existsSync(p) || readFileSync(p, 'utf8').includes('<ExtensionPageShell')) return;
  let c = ensureImports(readFileSync(p, 'utf8'));
  const headerRe =
    /<div class="space-y-6">\s*<div class="flex items-center justify-between">[\s\S]*?<\/div>\s*\n\s*(?=<(?:input|div class="form-control|#if loading))/;
  if (!headerRe.test(c)) {
    console.warn('wrapCrmSub: header not found', rel);
    return;
  }
  c = c.replace(headerRe, '');
  c = c.replace(
    '<div class="space-y-6">',
    `<ExtensionPageShell title={m['${titleKey}']()} subtitle={${subtitleExpr}}>
  {#snippet actions()}
    ${actionHtml.trim()}
  {/snippet}
  {#snippet children()}
  <div class="space-y-6">`,
  );
  c = c.replace(/\n<\/div>\s*\n<!-- Modal -->/, '\n  </div>\n  {/snippet}\n</ExtensionPageShell>\n\n<!-- Modal -->');
  if (!c.includes('</ExtensionPageShell>')) {
    c = c.replace(/\n<\/div>\s*$/, '\n  </div>\n  {/snippet}\n</ExtensionPageShell>\n');
  }
  writeFileSync(p, c);
  console.log('wrapped CRM', rel);
}

/** Wrap traceability subpage with p-6 header */
function wrapTraceSub(rel: string, titleKey: string, actionBtn?: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  if (c.includes('<ExtensionPageShell')) return;
  c = ensureImports(c);
  const headerRe =
    /<div class="p-6 space-y-4">\s*<div class="flex items-center justify-between">\s*<h1 class="text-2xl font-bold">\{m\['[^']+'\]\(\)\}<\/h1>\s*([\s\S]*?)<\/div>\s*/;
  const m = headerRe.exec(c);
  if (!m) {
    console.warn('wrapTraceSub: no header', rel);
    return;
  }
  const actionInner = actionBtn ?? m[1].trim();
  const actionsBlock = actionInner
    ? `  {#snippet actions()}\n    ${actionInner}\n  {/snippet}\n`
    : '';
  c = c.replace(
    headerRe,
    `<ExtensionPageShell title={m['${titleKey}']()}>\n${actionsBlock}  {#snippet children()}\n  <div class="p-6 space-y-4 pt-0">\n`,
  );
  c = c.replace(/\n<\/div>\s*$/, '\n  </div>\n  {/snippet}\n</ExtensionPageShell>\n');
  writeFileSync(p, c);
  console.log('wrapped trace', rel);
}

// --- Bulk string patches ---
const PATCHES: Record<string, [string, string][]> = {
  'content/documents/studio/pages/+page.svelte': [
    ['Generated Documents', "{m['content.documents.tab.generated']()}"],
    ['<Plus size={13} class="mr-1.5" /> Templates', "<Plus size={13} class=\"mr-1.5\" /> {m['content.documents.tab.templates']()}"],
    [
      "{t.variables.length} variable{t.variables.length !== 1 ? 's' : ''}",
      "{m['content.documents.variablesCount']({ n: String(t.variables.length) })}",
    ],
    ['<Plus size={11} /> Generate', "<Plus size={11} /> {m['content.documents.btn.generate']()}"],
    ['title="Request signature"', "title={m['content.documents.btn.requestSignature']()}"],
    ['title="View shared link"', "title={m['content.documents.btn.viewLink']()}"],
    ['{/if}Generate', "{/if}{m['content.documents.btn.generate']()}"],
    ['<Send size={13} /> Send', "<Send size={13} /> {m['content.documents.btn.send']()}"],
  ],
  'compliance/ro/procurement/studio/pages/+page.svelte': [
    ['Nu există comenzi de achizitie.', "{m['compliance.ro.procurement.empty.orders']()}"],
    ['<th>Număr</th>', "<th>{m['compliance.ro.procurement.col.number']()}</th>"],
    ['<th>Data</th>', "<th>{m['compliance.ro.procurement.col.date']()}</th>"],
    ['<th>Furnizor</th>', "<th>{m['compliance.ro.procurement.col.supplier']()}</th>"],
    ['<th>Descriere</th>', "<th>{m['compliance.ro.procurement.col.description']()}</th>"],
    ['<CheckCircle size={12} /> Receptie', "<CheckCircle size={12} /> {m['compliance.ro.procurement.col.reception']()}"],
    ['Nu există furnizori inregistrati.', "{m['compliance.ro.procurement.empty.suppliers']()}"],
    ['Nu există linii bugetare.', "{m['compliance.ro.procurement.empty.budget']()}"],
    ['>Creare comanda\n', ">{m['compliance.ro.procurement.btn.createOrderModal']()}\n"],
    ['>Inregistrare\n', ">{m['compliance.ro.procurement.btn.recordReception']()}\n"],
    ['<th>Articol</th>', "<th>{m['compliance.ro.procurement.col.article']()}</th>"],
    ['<th>Cant.</th>', "<th>{m['compliance.ro.procurement.col.qty']()}</th>"],
    ['<th>Pret unitar</th>', "<th>{m['compliance.ro.procurement.col.unitPrice']()}</th>"],
  ],
  'compliance/ro/documents/studio/pages/+page.svelte': [
    ['Parti implicate', "{m['compliance.ro.documents.ui.parties']()}"],
    ['>Creare\n', ">{m['compliance.ro.documents.btn.create']()}\n"],
  ],
  'content/document-templates/studio/pages/+page.svelte': [
    ['<th>Format</th>', "<th>{m['content.document-templates.col.format']()}</th>"],
    ['placeholder="template"', "placeholder={m['content.document-templates.placeholder.template']()}"],
    ['>DOCX</option>', ">{m['content.document-templates.format.docx']()}</option>"],
    ['<th>Description</th>', "<th>{m['content.document-templates.col.description']()}</th>"],
    ['Body — use {{var}} for substitution', "{m['content.document-templates.bodyHint']()}"],
    ['{#if saving}<LoaderCircle', "{#if saving}<LoaderCircle"],
    ['{/if} Save', "{/if}{m['common.save']()}"],
  ],
  'content/drafts/studio/pages/+page.svelte': [
    ['<th>Record</th>', "<th>{m['content.drafts.col.record']()}</th>"],
    ['<th>Author</th>', "<th>{m['content.drafts.col.author']()}</th>"],
    ['<th>Updated</th>', "<th>{m['content.drafts.col.updated']()}</th>"],
    ['>Publish\n', ">{m['content.drafts.btn.publish']()}\n"],
  ],
  'data/export/studio/pages/+page.svelte': [
    ['<th>Collection</th>', "<th>{m['data.export.col.collection']()}</th>"],
    ['<th>Format</th>', "<th>{m['data.export.col.format']()}</th>"],
    ['>Download\n', ">{m['data.export.btn.download']()}\n"],
  ],
  'data/import/studio/pages/+page.svelte': [
    ['<th>Format</th>', "<th>{m['data.import.col.format']()}</th>"],
    ['Upsert on field (optional, e.g. email)', "{m['data.import.upsertHint']()}"],
    ['toast.success(`Imported ${res.imported} rows`)', "toast.success(m['data.import.toast.imported']({ n: String(res.imported) }))"],
    [' · ${res.errors} errors — see job log', " + m['data.import.errorsHint']({ n: String(res.errors) })"],
  ],
  'developer/api-docs/studio/pages/+page.svelte': [
    ['>New page\n', ">{m['developer.api-docs.btn.newPage']()}\n"],
    ['>Generate token\n', ">{m['developer.api-docs.btn.generateToken']()}\n"],
    ['>Custom pages\n', ">{m['developer.api-docs.tab.customPages']()}\n"],
    ['>Access tokens\n', ">{m['developer.api-docs.tab.tokens']()}\n"],
    ['>Create\n', ">{m['developer.api-docs.btn.create']()}\n"],
  ],
  'developer/database/studio/pages/+page.svelte': [
    ['Showing first 50 of {total}.', "{m['developer.database.showingRows']({ n: String(total) })}"],
  ],
  'finance/quotes/studio/pages/+page.svelte': [
    ['>New Quote\n', ">{m['finance.quotes.btn.new']()}\n"],
    ['>Lines</', ">{m['finance.quotes.section.lines']()}</"],
    ['>Add line\n', ">{m['finance.quotes.btn.addLine']()}\n"],
    ['>Create Quote\n', ">{m['finance.quotes.btn.create']()}\n"],
    ['>Send\n', ">{m['finance.quotes.btn.send']()}\n"],
    ['>Mark accepted\n', ">{m['finance.quotes.btn.accept']()}\n"],
  ],
  'finance/subscriptions/studio/pages/+page.svelte': [
    ['<th>Code</th>', "<th>{m['finance.subscriptions.col.code']()}</th>"],
    ['<th>Name</th>', "<th>{m['finance.subscriptions.col.name']()}</th>"],
  ],
  'geospatial/postgis/studio/pages/+page.svelte': [
    ['>Proximity Search\n', ">{m['geospatial.postgis.tab.proximity']()}\n"],
    ['>Clustering\n', ">{m['geospatial.postgis.tab.clustering']()}\n"],
    ['>Search\n', ">{m['geospatial.postgis.btn.search']()}\n"],
    ['>Create\n', ">{m['geospatial.postgis.btn.create']()}\n"],
    ['No geofences yet.', "{m['geospatial.postgis.empty.geofences']()}"],
    ['<th>Collection</th>', "<th>{m['geospatial.postgis.col.collection']()}</th>"],
  ],
  'hr/payroll/studio/pages/+page.svelte': [
    ['>New period\n', ">{m['hr.payroll.btn.newPeriod']()}\n"],
    ['>Periods\n', ">{m['hr.payroll.tab.periods']()}\n"],
    ['No periods yet.', "{m['hr.payroll.empty.periods']()}"],
    ['>Generate\n', ">{m['hr.payroll.btn.generate']()}\n"],
    ['>Revisal XML\n', ">{m['hr.payroll.btn.revisal']()}\n"],
    ['<th>Gross</th>', "<th>{m['hr.payroll.col.gross']()}</th>"],
    ['<th>Net</th>', "<th>{m['hr.payroll.col.net']()}</th>"],
    ['>Create\n', ">{m['common.create']()}\n"],
  ],
  'i18n/translations/studio/pages/+page.svelte': [
    ['>Keys\n', ">{m['i18n.translations.tab.keys']()}\n"],
    ['>Locales\n', ">{m['i18n.translations.tab.locales']()}\n"],
    ['>Glossary\n', ">{m['i18n.translations.tab.glossary']()}\n"],
    ['<th>Name</th>', "<th>{m['i18n.translations.col.localeName']()}</th>"],
    ['>Search\n', ">{m['i18n.translations.btn.search']()}\n"],
  ],
  'integrations/api-connector/studio/pages/+page.svelte': [
    ['>New connection\n', ">{m['integrations.api-connector.btn.new']()}\n"],
    ['>Connections\n', ">{m['integrations.api-connector.tab.connections']()}\n"],
    ['>Incoming webhooks\n', ">{m['integrations.api-connector.tab.webhooks']()}\n"],
    ['>Call logs\n', ">{m['integrations.api-connector.tab.logs']()}\n"],
    ['No external API connections yet.', "{m['integrations.api-connector.empty.connections']()}"],
    ['<th>URL</th>', "<th>{m['integrations.api-connector.col.url']()}</th>"],
    ['<th>Last received</th>', "<th>{m['integrations.api-connector.col.lastReceived']()}</th>"],
    ['<th>Time</th>', "<th>{m['integrations.api-connector.col.time']()}</th>"],
    ['<th>Connection</th>', "<th>{m['integrations.api-connector.col.connection']()}</th>"],
    ['>Create\n', ">{m['integrations.api-connector.btn.create']()}\n"],
  ],
  'operations/assets/studio/pages/+page.svelte': [
    ['>New Asset\n', ">{m['operations.assets.btn.new']()}\n"],
    ['No assets registered yet.', "{m['operations.assets.empty']()}"],
    ['<th>Location</th>', "<th>{m['operations.assets.col.location']()}</th>"],
    ['<th>Cost</th>', "<th>{m['operations.assets.col.cost']()}</th>"],
    ['>Create\n', ">{m['operations.assets.btn.create']()}\n"],
  ],
  'projects/helpdesk/studio/pages/+page.svelte': [
    ['>New ticket\n', ">{m['projects.helpdesk.btn.new']()}\n"],
    ['Select a ticket to view the conversation.', "{m['projects.helpdesk.empty.select']()}"],
    ['>Create\n', ">{m['projects.helpdesk.btn.create']()}\n"],
    ['<th>Category</th>', "<th>{m['projects.helpdesk.col.category']()}</th>"],
    ['>Low</option>', ">{m['projects.helpdesk.priority.low']()}</option>"],
    ['>High</option>', ">{m['projects.helpdesk.priority.high']()}</option>"],
  ],
  'projects/management/studio/pages/+page.svelte': [
    ['>New project\n', ">{m['projects.management.btn.newProject']()}\n"],
    ['>New task\n', ">{m['projects.management.btn.newTask']()}\n"],
    ['>Create\n', ">{m['common.create']()}\n"],
    ['<th>Status</th>', "<th>{m['projects.management.col.status']()}</th>"],
    ['<th>Priority</th>', "<th>{m['projects.management.col.priority']()}</th>"],
    ['<th>Due date</th>', "<th>{m['projects.management.col.dueDate']()}</th>"],
  ],
  'storage/cloud/studio/pages/+page.svelte': [
    ['Empty folder. Drag files here or click Upload.', "{m['storage.cloud.empty.folder']()}"],
    ['>Share\n', ">{m['storage.cloud.btn.share']()}\n"],
  ],
  'workflow/approvals/studio/pages/+page.svelte': [
    ['>Workflows\n', ">{m['workflow.approvals.tab.workflowsLabel']()}\n"],
  ],
  'workflow/checklists/studio/pages/+page.svelte': [
    ['>Create\n', ">{m['workflow.checklists.btn.create']()}\n"],
    ['>item</th>', ">{m['workflow.checklists.col.item']()}</th>"],
    ['>Responses\n', ">{m['workflow.checklists.tab.responses']()}\n"],
    ['>Edit\n', ">{m['workflow.checklists.btn.edit']()}\n"],
    ['<th>Items</th>', "<th>{m['workflow.checklists.col.items']()}</th>"],
    ['<th>Required</th>', "<th>{m['workflow.checklists.col.required']()}</th>"],
    ['>Add\n', ">{m['workflow.checklists.btn.add']()}\n"],
  ],
  'content/page-builder/studio/pages/+page.svelte': [
    ['>Page Settings', ">{m['content.page-builder.section.settings']()}"],
  ],
};

for (const [rel, reps] of Object.entries(PATCHES)) patch(rel, reps);

// Media: PageHeader -> ExtensionPageShell + i18n buttons
{
  const p = join(EXT, 'content/media/studio/pages/+page.svelte');
  if (existsSync(p)) {
    let c = readFileSync(p, 'utf8');
    c = c.replace("import PageHeader from '$lib/components/common/PageHeader.svelte';\n", '');
    if (!c.includes('ExtensionPageShell')) {
      c = c.replace(
        /<script lang="ts">\n/,
        "<script lang=\"ts\">\n  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';\n",
      );
    }
    c = c.replace(
      '<PageHeader title={m[\'content.media.title\']()} subtitle={m[\'content.media.subtitle\']()} />',
      "<ExtensionPageShell title={m['content.media.title']()} subtitle={m['content.media.subtitle']()}>\n  {#snippet children()}",
    );
    if (!c.includes('</ExtensionPageShell>')) {
      c = c.replace(/\n<\/div>\s*\n<!-- modals/i, '\n  </div>\n  {/snippet}\n</ExtensionPageShell>\n\n<!-- modals');
      if (!c.includes('</ExtensionPageShell>')) {
        c = c.replace(/\n<\/div>\s*$/, '\n  </div>\n  {/snippet}\n</ExtensionPageShell>\n');
      }
    }
    c = c.replace("selectFolder(null, name = 'All Files')", "selectFolder(null, name = m['content.media.allFiles']())");
    c = c.replace("title: 'Delete Folder'", "title: m['content.media.confirm.deleteFolderTitle']()");
    c = c.replace("message: 'Delete this folder?'", "message: m['content.media.confirm.deleteFolderMsg']()");
    const mediaPatches: [string, string][] = [
      ['>All Files<', ">{m['content.media.allFiles']()}<"],
      ['{files.length} files', "{m['content.media.filesCount']({ n: String(files.length) })"],
      ['>Upload<', ">{m['content.media.btn.upload']()}<"],
      ['>Select all', ">{m['content.media.btn.selectAll']()"],
      ['>Download<', ">{m['content.media.btn.download']()}<"],
      ['Empty folder. Drag files here or click Upload.', "{m['content.media.empty.folder']()}"],
    ];
    for (const [a, b] of mediaPatches) c = c.split(a).join(b);
    writeFileSync(p, c);
    console.log('updated media');
  }
}

// CRM subroutes: maintained manually in repo (wrapCrmSub removed — too fragile)

// Traceability subroutes
wrapTraceSub(
  'operations/traceability/studio/pages/production/+page.svelte',
  'operations.traceability.production.title',
  '<button class="btn btn-primary btn-sm" onclick={() => (showNewForm = true)}>{m[\'operations.traceability.production.newOrder\']()}</button>',
);
wrapTraceSub('operations/traceability/studio/pages/dispatches/+page.svelte', 'operations.traceability.dispatches.title');
wrapTraceSub('operations/traceability/studio/pages/reception/+page.svelte', 'operations.traceability.reception.title');
wrapTraceSub('operations/traceability/studio/pages/reports/+page.svelte', 'operations.traceability.reports.title');
wrapTraceSub('operations/traceability/studio/pages/recalls/+page.svelte', 'operations.traceability.recalls.title');

// lots/[id] - different structure
{
  const rel = 'operations/traceability/studio/pages/lots/[id]/+page.svelte';
  const p = join(EXT, rel);
  if (existsSync(p) && !readFileSync(p, 'utf8').includes('<ExtensionPageShell')) {
    let c = ensureImports(readFileSync(p, 'utf8'));
    const re = /<div class="p-6[^"]*">\s*<h1 class="text-2xl font-bold">([\s\S]*?)<\/h1>/;
    if (re.test(c)) {
      c = c.replace(re, `<ExtensionPageShell title={m['operations.traceability.lots.title']()}>\n  {#snippet children()}\n  <div class="p-6 space-y-4 pt-0">`);
      c = c.replace(/\n<\/div>\s*$/, '\n  </div>\n  {/snippet}\n</ExtensionPageShell>\n');
      writeFileSync(p, c);
      console.log('wrapped trace lots');
    }
  }
}

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('keys', Object.keys(en).length);
