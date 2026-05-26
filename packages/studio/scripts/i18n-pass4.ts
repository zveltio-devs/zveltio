#!/usr/bin/env bun
/** Pass 4: fix corrupted pages, remaining strings, shell on AI/mail/validation/edge */
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

const KEYS: [string, string, string][] = [
  ['geospatial.postgis.tab.geofencesCount', 'Geofences ({n})', 'Geofence ({n})'],
  ['geospatial.postgis.resultsCount', '{n} results', '{n} rezultate'],
  ['geospatial.postgis.distanceMeters', '{d} m away', '{d} m distanță'],
  ['geospatial.postgis.cluster.apiHint', 'Use the API endpoint', 'Folosește endpoint-ul API'],
  [
    'geospatial.postgis.cluster.returnsHint',
    'Returns clusters with centroid coordinates and point counts.',
    'Returnează clustere cu coordonate centroid și număr de puncte.',
  ],
  ['content.media.confirm.deleteFileTitle', 'Delete file', 'Șterge fișier'],
  ['content.media.confirm.deleteFilesTitle', 'Delete selected files', 'Șterge fișierele selectate'],
  [
    'content.media.confirm.deleteFilesMsg',
    'Delete {n} selected files?',
    'Ștergi {n} fișiere selectate?',
  ],
  ['content.media.btn.deleteSelected', 'Delete ({n})', 'Șterge ({n})'],
  ['content.media.uploadFilesCount', 'Upload {n} file(s)', 'Încarcă {n} fișier(e)'],
  ['storage.cloud.shareTitle', 'Share {name}', 'Partajează {name}'],
  ['workflow.checklists.itemsCount', '{n} item(s)', '{n} element(e)'],
  ['data.import.label.format', 'Format', 'Format'],
  [
    'data.import.label.upsertHtml',
    'Upsert on field (optional, e.g. email)',
    'Upsert pe câmp (opțional, ex. email)',
  ],
  ['developer.edge-functions.shell.title', 'Edge Functions', 'Funcții Edge'],
  [
    'developer.edge-functions.shell.subtitle',
    'Deploy and test serverless functions',
    'Deploy și testează funcții serverless',
  ],
  [
    'communications.mail.shell.useLayout',
    'Full-height mail client',
    'Client mail pe înălțime completă',
  ],
];

for (const [k, e, r] of KEYS) add(k, e, r);

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

/** Truncate file after first </ExtensionPageShell> if duplicate markup follows */
function dedupeAfterShell(rel: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  const c = readFileSync(p, 'utf8');
  const marker = '</ExtensionPageShell>';
  const idx = c.indexOf(marker);
  if (idx < 0) return;
  const after = c.slice(idx + marker.length).trimStart();
  if (after.startsWith('{#if') || after.startsWith('<div')) {
    writeFileSync(p, c.slice(0, idx + marker.length) + '\n');
    console.log('deduped shell tail', rel);
  }
}

/** Dedupe second duplicate block marker */
function dedupeSecond(rel: string, marker: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  const c = readFileSync(p, 'utf8');
  const first = c.indexOf(marker);
  if (first < 0) return;
  const second = c.indexOf(marker, first + marker.length);
  if (second < 0) return;
  writeFileSync(p, c.slice(0, second).trimEnd() + '\n');
  console.log('deduped', rel);
}

dedupeAfterShell('geospatial/postgis/studio/pages/+page.svelte');
dedupeSecond('data/import/studio/pages/+page.svelte', '{#if showForm}');

const P: Record<string, [string, string][]> = {
  'geospatial/postgis/studio/pages/+page.svelte': [
    ['>Proximity Search</button>', ">{m['geospatial.postgis.tab.proximity']()}</button>"],
    [
      '>Geofences ({geofences.length})</button>',
      ">{m['geospatial.postgis.tab.geofencesCount']({ n: String(geofences.length) })}</button>",
    ],
    ['>Clustering</button>', ">{m['geospatial.postgis.tab.clustering']()}</button>"],
    ['{/if} Search\n', "{/if}{m['geospatial.postgis.btn.search']()}\n"],
    [
      '{nearResults.length} results</p>',
      "{m['geospatial.postgis.resultsCount']({ n: String(nearResults.length) })}</p>",
    ],
    [
      '{Math.round(r.distance_meters)}m away</span>',
      "{m['geospatial.postgis.distanceMeters']({ d: String(Math.round(r.distance_meters)) })}</span>",
    ],
    ['{/if} Create\n', "{/if}{m['geospatial.postgis.btn.create']()}\n"],
    ['Use the API endpoint', "{m['geospatial.postgis.cluster.apiHint']()}"],
    [
      'Returns clusters with centroid coordinates and point counts.',
      "{m['geospatial.postgis.cluster.returnsHint']()}",
    ],
  ],
  'compliance/ro/procurement/studio/pages/+page.svelte': [
    ['{/if} Creare comanda', "{/if}{m['compliance.ro.procurement.btn.createOrderModal']()}"],
    ['{/if} Inregistrare', "{/if}{m['compliance.ro.procurement.btn.recordReception']()}"],
  ],
  'content/document-templates/studio/pages/+page.svelte': [
    ['<th>Description</th>', "<th>{m['content.document-templates.col.description']()}</th>"],
    ['Body — use {{var}} for substitution', "{m['content.document-templates.bodyHint']()}"],
    [
      'placeholder="template"',
      "placeholder={m['content.document-templates.placeholder.template']()}",
    ],
    ['{/if} Save', "{/if}{m['common.save']()}"],
  ],
  'content/drafts/studio/pages/+page.svelte': [
    ['<Send size={11} /> Publish', "<Send size={11} /> {m['content.drafts.btn.publish']()}"],
  ],
  'content/media/studio/pages/+page.svelte': [
    ["title: 'Delete File'", "title: m['content.media.confirm.deleteFileTitle']()"],
    ["title: 'Delete Files'", "title: m['content.media.confirm.deleteFilesTitle']()"],
    [
      '`Delete ${selectedFiles.size} selected files?`',
      "m['content.media.confirm.deleteFilesMsg']({ n: String(selectedFiles.size) })",
    ],
    [
      '<Trash2 size={14} /> Delete ({selectedFiles.size})',
      "<Trash2 size={14} /> {m['content.media.btn.deleteSelected']({ n: String(selectedFiles.size) })",
    ],
    ['>Download</a>', ">{m['content.media.btn.download']()}</a>"],
    [
      '<Download size={16} /> Download',
      "<Download size={16} /> {m['content.media.btn.download']()}",
    ],
    ['<Trash2 size={16} /> Delete', "<Trash2 size={16} /> {m['common.delete']()}"],
  ],
  'data/export/studio/pages/+page.svelte': [
    [
      '<Download class="h-4 w-4" /> Download</button>',
      '<Download class="h-4 w-4" /> {m[\'data.export.btn.download\']()}</button>',
    ],
  ],
  'data/import/studio/pages/+page.svelte': [
    [
      '<label class="label label-text">Format</label>',
      '<label class="label label-text">{m[\'data.import.label.format\']()}</label>',
    ],
    [
      'Upsert on field (optional, e.g. <code class="text-xs">email</code>)',
      "{m['data.import.label.upsertHtml']()}",
    ],
    [
      '<div class="font-medium">Imported {result.rows_imported ?? \'?\'} rows</div>',
      "<div class=\"font-medium\">{m['data.import.toast.imported']({ n: String(result.rows_imported ?? '?') })}</div>",
    ],
    [
      '{result.errors.length} errors — see job log</div>',
      "{m['data.import.errorsHint']({ n: String(result.errors.length) })}</div>",
    ],
  ],
  'developer/api-docs/studio/pages/+page.svelte': [
    ['<Plus size={14} /> New page', "<Plus size={14} /> {m['developer.api-docs.btn.newPage']()}"],
    ['>Generate token\n', ">{m['developer.api-docs.btn.generateToken']()}\n"],
    ['>Custom pages\n', ">{m['developer.api-docs.tab.customPages']()}\n"],
    ['>Access tokens\n', ">{m['developer.api-docs.tab.tokens']()}\n"],
    ['>Create\n', ">{m['developer.api-docs.btn.create']()}\n"],
  ],
  'developer/database/studio/pages/+page.svelte': [
    ['Showing first 50 of {total}.', "{m['developer.database.showingRows']({ n: String(total) })}"],
  ],
  'finance/quotes/studio/pages/+page.svelte': [
    ['<Plus size={14} /> New Quote', "<Plus size={14} /> {m['finance.quotes.btn.new']()}"],
    ['>Add line\n', ">{m['finance.quotes.btn.addLine']()}\n"],
    ['>Create Quote\n', ">{m['finance.quotes.btn.create']()}\n"],
    ['>Send\n', ">{m['finance.quotes.btn.send']()}\n"],
    ['>Mark accepted\n', ">{m['finance.quotes.btn.accept']()}\n"],
  ],
  'finance/subscriptions/studio/pages/+page.svelte': [
    ['<th>Code</th>', "<th>{m['finance.subscriptions.col.code']()}</th>"],
    ['<th>Name</th>', "<th>{m['finance.subscriptions.col.name']()}</th>"],
  ],
  'hr/payroll/studio/pages/+page.svelte': [
    ['<Plus size={14} /> New period', "<Plus size={14} /> {m['hr.payroll.btn.newPeriod']()}"],
    ['>Periods\n', ">{m['hr.payroll.tab.periods']()}\n"],
    ['>Generate\n', ">{m['hr.payroll.btn.generate']()}\n"],
    [
      '<Download size={13} /> Revisal XML',
      "<Download size={13} /> {m['hr.payroll.btn.revisal']()}",
    ],
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
    [
      '<Plus size={14} /> New connection',
      "<Plus size={14} /> {m['integrations.api-connector.btn.new']()}",
    ],
    ['>Connections\n', ">{m['integrations.api-connector.tab.connections']()}\n"],
    ['>Incoming webhooks\n', ">{m['integrations.api-connector.tab.webhooks']()}\n"],
    ['>Call logs\n', ">{m['integrations.api-connector.tab.logs']()}\n"],
    ['>Create\n', ">{m['integrations.api-connector.btn.create']()}\n"],
  ],
  'operations/assets/studio/pages/+page.svelte': [
    ['>New Asset\n', ">{m['operations.assets.btn.new']()}\n"],
    ['>Create\n', ">{m['operations.assets.btn.create']()}\n"],
  ],
  'projects/helpdesk/studio/pages/+page.svelte': [
    ['>New ticket\n', ">{m['projects.helpdesk.btn.new']()}\n"],
    ['>Create\n', ">{m['projects.helpdesk.btn.create']()}\n"],
    ['<th>Category</th>', "<th>{m['projects.helpdesk.col.category']()}</th>"],
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
    [
      '<h3 class="font-semibold">Share {selected?.name}</h3>',
      "<h3 class=\"font-semibold\">{m['storage.cloud.shareTitle']({ name: selected?.name ?? '' })}</h3>",
    ],
    ['>Share\n', ">{m['storage.cloud.btn.share']()}\n"],
  ],
  'workflow/approvals/studio/pages/+page.svelte': [
    [
      '<Workflow size={13} class="mr-1.5" /> Workflows',
      '<Workflow size={13} class="mr-1.5" /> {m[\'workflow.approvals.tab.workflowsLabel\']()}',
    ],
  ],
  'workflow/checklists/studio/pages/+page.svelte': [
    ['\n            Create\n', "\n            {m['workflow.checklists.btn.create']()}\n"],
    [
      '<BarChart2 size={13}/> Responses',
      "<BarChart2 size={13}/> {m['workflow.checklists.tab.responses']()}",
    ],
    ['Edit <ChevronRight', "{m['workflow.checklists.btn.edit']()} <ChevronRight"],
    [
      "{(c.items ?? []).length} item{(c.items ?? []).length !== 1 ? 's' : ''}",
      "{m['workflow.checklists.itemsCount']({ n: String((c.items ?? []).length) })",
    ],
    ['>Add\n', ">{m['workflow.checklists.btn.add']()}\n"],
    ['<th>Items</th>', "<th>{m['workflow.checklists.col.items']()}</th>"],
    ['<th>Required</th>', "<th>{m['workflow.checklists.col.required']()}</th>"],
    ['>item</th>', ">{m['workflow.checklists.col.item']()}</th>"],
  ],
  'developer/edge-functions/studio/pages/+page.svelte': [
    [
      ": {m['developer.edge-functions.status.inactive']()}",
      ": m['developer.edge-functions.status.inactive']()",
    ],
  ],
};

for (const [rel, reps] of Object.entries(P)) patch(rel, reps);

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('keys', Object.keys(en).length);
