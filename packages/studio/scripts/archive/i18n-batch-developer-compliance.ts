#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

const KEYS: Record<string, { en: string; ro: string }> = {
  // e-Factura
  'compliance.ro.efactura.btn.newInvoice': { en: 'New Invoice', ro: 'Factură nouă' },
  'compliance.ro.efactura.btn.createInvoice': { en: 'Create Invoice', ro: 'Creează factura' },
  'compliance.ro.efactura.empty.invoices': { en: 'No invoices', ro: 'Nicio factură' },
  'compliance.ro.efactura.col.buyer': { en: 'Buyer', ro: 'Cumpărător' },
  'compliance.ro.efactura.col.anafIndex': { en: 'ANAF Index', ro: 'Index ANAF' },
  'compliance.ro.efactura.section.seller': { en: 'Seller (Issuer)', ro: 'Vânzător (Emitent)' },
  'compliance.ro.efactura.section.buyer': {
    en: 'Buyer (Beneficiary)',
    ro: 'Cumpărător (Beneficiar)',
  },
  'compliance.ro.efactura.section.lines': { en: 'Invoice lines', ro: 'Linii factură' },
  'compliance.ro.efactura.col.qty': { en: 'Qty', ro: 'Cant.' },
  'compliance.ro.efactura.col.unit': { en: 'Unit', ro: 'UM' },
  'compliance.ro.efactura.col.vatPercent': { en: 'VAT%', ro: 'TVA%' },
  'compliance.ro.efactura.col.vat': { en: 'VAT', ro: 'TVA' },
  'compliance.ro.efactura.totals.subtotal': { en: 'Subtotal', ro: 'Subtotal' },
  'compliance.ro.efactura.totals.vat': { en: 'VAT', ro: 'TVA' },
  'compliance.ro.efactura.totals.total': { en: 'Total', ro: 'Total' },
  'compliance.ro.efactura.status.draft': { en: 'Draft', ro: 'Ciornă' },
  'compliance.ro.efactura.status.xmlGenerated': { en: 'XML generated', ro: 'XML generat' },
  'compliance.ro.efactura.status.submitted': { en: 'Submitted', ro: 'Trimis' },
  'compliance.ro.efactura.status.accepted': { en: 'Accepted', ro: 'Acceptat' },
  'compliance.ro.efactura.status.rejected': { en: 'Rejected', ro: 'Respins' },
  'compliance.ro.efactura.toast.submissionFailed': {
    en: 'Submission failed',
    ro: 'Trimiterea a eșuat',
  },
  // e-Transport
  'compliance.ro.etransport.btn.newDeclaration': { en: 'New Declaration', ro: 'Declarație nouă' },
  'compliance.ro.etransport.btn.createDeclaration': {
    en: 'Create Declaration',
    ro: 'Creează declarația',
  },
  'compliance.ro.etransport.empty.declarations': {
    en: 'No transport declarations',
    ro: 'Nicio declarație de transport',
  },
  'compliance.ro.etransport.col.uit': { en: 'UIT', ro: 'UIT' },
  'compliance.ro.etransport.col.vehicle': { en: 'Vehicle', ro: 'Vehicul' },
  'compliance.ro.etransport.col.driver': { en: 'Driver', ro: 'Șofer' },
  'compliance.ro.etransport.col.route': { en: 'Route', ro: 'Rută' },
  'compliance.ro.etransport.col.weightKg': { en: 'Weight (kg)', ro: 'Greutate (kg)' },
  'compliance.ro.etransport.section.departure': { en: 'Departure', ro: 'Plecare' },
  'compliance.ro.etransport.section.destination': { en: 'Destination', ro: 'Destinație' },
  'compliance.ro.etransport.section.goods': { en: 'Goods', ro: 'Mărfuri' },
  'compliance.ro.etransport.col.tariffCode': { en: 'Tariff code', ro: 'Cod tarifar' },
  'compliance.ro.etransport.totals.weight': { en: 'Total weight', ro: 'Greutate totală' },
  'compliance.ro.etransport.status.draft': { en: 'Draft', ro: 'Ciornă' },
  'compliance.ro.etransport.status.declared': { en: 'Declared', ro: 'Declarat' },
  'compliance.ro.etransport.status.inTransit': { en: 'In transit', ro: 'În tranzit' },
  'compliance.ro.etransport.status.completed': { en: 'Completed', ro: 'Finalizat' },
  'compliance.ro.etransport.status.cancelled': { en: 'Cancelled', ro: 'Anulat' },
  'compliance.ro.etransport.action.declare': { en: 'Declare to ANAF', ro: 'Declară la ANAF' },
  'compliance.ro.etransport.action.complete': { en: 'Mark completed', ro: 'Marchează finalizat' },
  'compliance.ro.etransport.action.cancel': { en: 'Cancel', ro: 'Anulează' },
  // BYOD
  'developer.byod.intro': {
    en: 'Connect to an external PostgreSQL database, scan its schema, and surface tables as virtual collections in Zveltio.',
    ro: 'Conectează o bază PostgreSQL externă, scanează schema și expune tabelele ca colecții virtuale în Zveltio.',
  },
  'developer.byod.tab.profiles': { en: 'Connection profiles', ro: 'Profiluri conexiune' },
  'developer.byod.tab.history': { en: 'Scan history', ro: 'Istoric scanări' },
  'developer.byod.col.schema': { en: 'Schema', ro: 'Schemă' },
  'developer.byod.col.lastScan': { en: 'Last scan', ro: 'Ultima scanare' },
  'developer.byod.col.tablesFound': { en: 'Tables found', ro: 'Tabele găsite' },
  'developer.byod.col.profile': { en: 'Profile', ro: 'Profil' },
  'developer.byod.col.started': { en: 'Started', ro: 'Început' },
  'developer.byod.col.tables': { en: 'Tables', ro: 'Tabele' },
  'developer.byod.btn.scan': { en: 'Scan', ro: 'Scanează' },
  'developer.byod.btn.scanning': { en: 'Scanning…', ro: 'Se scanează…' },
  'developer.byod.empty.scans': { en: 'No scans yet.', ro: 'Nicio scanare încă.' },
  'developer.byod.never': { en: 'never', ro: 'niciodată' },
  'developer.byod.form.name': { en: 'Name', ro: 'Nume' },
  'developer.byod.form.connectionString': { en: 'Connection string', ro: 'Șir conexiune' },
  'developer.byod.form.schema': { en: 'Schema', ro: 'Schemă' },
  'developer.byod.form.includePatterns': {
    en: 'Include patterns (comma-separated)',
    ro: 'Pattern-uri incluse (separate prin virgulă)',
  },
  'developer.byod.form.excludePatterns': { en: 'Exclude patterns', ro: 'Pattern-uri excluse' },
  'developer.byod.saving': { en: 'Saving…', ro: 'Se salvează…' },
  // GraphQL
  'developer.graphql.tab.playground': { en: 'Playground', ro: 'Playground' },
  'developer.graphql.tab.logs': { en: 'Operation logs', ro: 'Jurnal operații' },
  'developer.graphql.tab.persisted': { en: 'Persisted queries', ro: 'Interogări persistate' },
  'developer.graphql.tab.policies': { en: 'Field policies', ro: 'Politici câmpuri' },
  'developer.graphql.panel.query': { en: 'Query', ro: 'Interogare' },
  'developer.graphql.panel.response': { en: 'Response', ro: 'Răspuns' },
  'developer.graphql.btn.run': { en: 'Run', ro: 'Rulează' },
  'developer.graphql.placeholder.output': {
    en: '(run a query to see output)',
    ro: '(rulează o interogare pentru rezultat)',
  },
  'developer.graphql.col.time': { en: 'Time', ro: 'Ora' },
  'developer.graphql.col.operation': { en: 'Operation', ro: 'Operație' },
  'developer.graphql.col.user': { en: 'User', ro: 'Utilizator' },
  'developer.graphql.col.roles': { en: 'Roles', ro: 'Roluri' },
  'developer.graphql.col.mode': { en: 'Mode', ro: 'Mod' },
  'developer.graphql.status.ok': { en: 'ok', ro: 'ok' },
  'developer.graphql.status.error': { en: 'error', ro: 'eroare' },
  'developer.graphql.error.queryFailed': { en: 'Query failed', ro: 'Interogarea a eșuat' },
  // API docs
  'developer.api-docs.tab.changelog': { en: 'Changelog', ro: 'Jurnal modificări' },
  'developer.api-docs.link.openApi': {
    en: 'View OpenAPI spec →',
    ro: 'Vezi specificația OpenAPI →',
  },
  'developer.api-docs.empty.changelog': {
    en: 'No changelog entries.',
    ro: 'Nicio intrare în jurnal.',
  },
  'developer.api-docs.col.public': { en: 'Public', ro: 'Public' },
  'developer.api-docs.col.updated': { en: 'Updated', ro: 'Actualizat' },
  'developer.api-docs.col.token': { en: 'Token', ro: 'Token' },
  'developer.api-docs.col.lastUsed': { en: 'Last used', ro: 'Ultima utilizare' },
  // Validation (one leftover)
  'developer.validation.form.description': { en: 'Description', ro: 'Descriere' },
  // Database browser
  'developer.database.tables': { en: 'Tables', ro: 'Tabele' },
  'developer.database.loading': { en: 'Loading…', ro: 'Se încarcă…' },
  'developer.database.noTables': { en: 'No tables.', ro: 'Nicio tabelă.' },
  'developer.database.selectTable': {
    en: 'Select a table to inspect.',
    ro: 'Selectează o tabelă pentru inspecție.',
  },
  'developer.database.rows': { en: 'rows', ro: 'rânduri' },
  'developer.database.columns': { en: 'columns', ro: 'coloane' },
  'developer.database.section.schema': { en: 'Schema', ro: 'Schemă' },
  'developer.database.col.column': { en: 'Column', ro: 'Coloană' },
  'developer.database.col.nullable': { en: 'Nullable', ro: 'Nullable' },
  'developer.database.col.default': { en: 'Default', ro: 'Implicit' },
  'developer.database.section.sampleRows': { en: 'Sample rows', ro: 'Rânduri eșantion' },
  'developer.database.noRows': { en: 'No rows.', ro: 'Niciun rând.' },
  'developer.database.yes': { en: 'yes', ro: 'da' },
  'developer.database.no': { en: 'no', ro: 'nu' },
  // Views
  'developer.views.btn.newView': { en: 'New view', ro: 'Vizualizare nouă' },
  'developer.views.empty': { en: 'No saved views yet.', ro: 'Nicio vizualizare salvată.' },
  'developer.views.error.invalidJson': {
    en: 'Invalid JSON in config',
    ro: 'JSON invalid în config',
  },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

function dedupeAtSecond(rel: string, marker: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  const c = readFileSync(p, 'utf8');
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const first = re.exec(c);
  if (!first) return;
  const second = re.exec(c);
  if (!second) return;
  writeFileSync(p, c.slice(0, second.index).trimEnd() + '\n');
  console.log('deduped', rel);
}

function patch(rel: string, reps: [string, string][]) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of reps) c = c.replaceAll(a, b);
  if (c !== o) {
    writeFileSync(p, c);
    console.log('patched', rel);
  }
}

dedupeAtSecond('developer/byod/studio/pages/+page.svelte', "{#if tab === 'profiles'}");
dedupeAtSecond('developer/graphql/studio/pages/+page.svelte', "{#if tab === 'playground'}");

const efacturaStatusFn = `
  function invoiceStatusLabel(s: string): string {
    const map: Record<string, () => string> = {
      all: () => m['common.filter.all'](),
      draft: () => m['compliance.ro.efactura.status.draft'](),
      xml_generated: () => m['compliance.ro.efactura.status.xmlGenerated'](),
      submitted: () => m['compliance.ro.efactura.status.submitted'](),
      accepted: () => m['compliance.ro.efactura.status.accepted'](),
      rejected: () => m['compliance.ro.efactura.status.rejected'](),
    };
    return (map[s] ?? (() => s))();
  }
`;

const etransportStatusFn = `
  function transportStatusLabel(s: string): string {
    const map: Record<string, () => string> = {
      all: () => m['common.filter.all'](),
      draft: () => m['compliance.ro.etransport.status.draft'](),
      declared: () => m['compliance.ro.etransport.status.declared'](),
      in_transit: () => m['compliance.ro.etransport.status.inTransit'](),
      completed: () => m['compliance.ro.etransport.status.completed'](),
      cancelled: () => m['compliance.ro.etransport.status.cancelled'](),
    };
    return (map[s] ?? (() => s))();
  }
`;

function injectFn(rel: string, anchor: string, fn: string) {
  const p = join(EXT, rel);
  let c = readFileSync(p, 'utf8');
  if (c.includes('invoiceStatusLabel') || c.includes('transportStatusLabel')) return;
  if (!c.includes(anchor)) return;
  c = c.replace(anchor, fn.trim() + '\n\n' + anchor);
  writeFileSync(p, c);
}

injectFn(
  'compliance/ro/efactura/studio/pages/+page.svelte',
  '  function statusBadge(status: string): string {',
  efacturaStatusFn,
);
injectFn(
  'compliance/ro/etransport/studio/pages/+page.svelte',
  '  function statusBadge(status: string): string {',
  etransportStatusFn,
);

patch('compliance/ro/efactura/studio/pages/+page.svelte', [
  [
    '<Plus size={14} /> New Invoice</button>',
    "<Plus size={14} /> {m['compliance.ro.efactura.btn.newInvoice']()}</button>",
  ],
  ["{s === 'all' ? m['common.filter.all']() : s.replace('_', ' ')}", '{invoiceStatusLabel(s)}'],
  [
    '<FileText size={40} class="opacity-20 mb-2" /> No invoices',
    '<FileText size={40} class="opacity-20 mb-2" /> {m[\'compliance.ro.efactura.empty.invoices\']()}',
  ],
  ['<th>Buyer</th>', "<th>{m['compliance.ro.efactura.col.buyer']()}</th>"],
  ['<th>ANAF Index</th>', "<th>{m['compliance.ro.efactura.col.anafIndex']()}</th>"],
  [
    '<p class="font-semibold text-sm mb-2">Seller (Emitent)</p>',
    '<p class="font-semibold text-sm mb-2">{m[\'compliance.ro.efactura.section.seller\']()}</p>',
  ],
  [
    '<p class="font-semibold text-sm mb-2">Buyer (Beneficiar)</p>',
    '<p class="font-semibold text-sm mb-2">{m[\'compliance.ro.efactura.section.buyer\']()}</p>',
  ],
  [
    '<p class="font-semibold text-sm">Invoice lines</p>',
    '<p class="font-semibold text-sm">{m[\'compliance.ro.efactura.section.lines\']()}</p>',
  ],
  ['<th>Qty</th>', "<th>{m['compliance.ro.efactura.col.qty']()}</th>"],
  ['<th>Unit</th>', "<th>{m['compliance.ro.efactura.col.unit']()}</th>"],
  ['<th>VAT%</th>', "<th>{m['compliance.ro.efactura.col.vatPercent']()}</th>"],
  ['<th>VAT</th>', "<th>{m['compliance.ro.efactura.col.vat']()}</th>"],
  ['<p>Subtotal:', "<p>{m['compliance.ro.efactura.totals.subtotal']()}:"],
  ['<p>TVA:', "<p>{m['compliance.ro.efactura.totals.vat']()}:"],
  [
    '<p class="text-base font-bold">Total:',
    '<p class="text-base font-bold">{m[\'compliance.ro.efactura.totals.total\']()}:',
  ],
  [' Create Invoice', " {m['compliance.ro.efactura.btn.createInvoice']()}"],
  [
    "toast.error(e?.message ?? 'Submission failed')",
    "toast.error(e?.message ?? m['compliance.ro.efactura.toast.submissionFailed']())",
  ],
]);

patch('compliance/ro/etransport/studio/pages/+page.svelte', [
  [
    '<Plus size={14} /> New Declaration</button>',
    "<Plus size={14} /> {m['compliance.ro.etransport.btn.newDeclaration']()}</button>",
  ],
  ["{s === 'all' ? m['common.filter.all']() : s.replace('_', ' ')}", '{transportStatusLabel(s)}'],
  [
    '<Truck size={40} class="opacity-20 mb-2" /> No transport declarations',
    '<Truck size={40} class="opacity-20 mb-2" /> {m[\'compliance.ro.etransport.empty.declarations\']()}',
  ],
  ['<th>UIT</th>', "<th>{m['compliance.ro.etransport.col.uit']()}</th>"],
  ['<th>Vehicle</th>', "<th>{m['compliance.ro.etransport.col.vehicle']()}</th>"],
  ['<th>Driver</th>', "<th>{m['compliance.ro.etransport.col.driver']()}</th>"],
  ['<th>Route</th>', "<th>{m['compliance.ro.etransport.col.route']()}</th>"],
  ['<th>Weight (kg)</th>', "<th>{m['compliance.ro.etransport.col.weightKg']()}</th>"],
  ['title="Declare to ANAF"', "title={m['compliance.ro.etransport.action.declare']()}"],
  ['title="Mark completed"', "title={m['compliance.ro.etransport.action.complete']()}"],
  ['title="Cancel"', "title={m['compliance.ro.etransport.action.cancel']()}"],
  [
    '<p class="font-semibold text-sm mb-2">Departure</p>',
    '<p class="font-semibold text-sm mb-2">{m[\'compliance.ro.etransport.section.departure\']()}</p>',
  ],
  [
    '<p class="font-semibold text-sm mb-2">Destination</p>',
    '<p class="font-semibold text-sm mb-2">{m[\'compliance.ro.etransport.section.destination\']()}</p>',
  ],
  [
    '<p class="font-semibold text-sm">Goods</p>',
    '<p class="font-semibold text-sm">{m[\'compliance.ro.etransport.section.goods\']()}</p>',
  ],
  ['<th>Tariff code</th>', "<th>{m['compliance.ro.etransport.col.tariffCode']()}</th>"],
  ['<th>Qty</th>', "<th>{m['compliance.ro.efactura.col.qty']()}</th>"],
  ['<th>Unit</th>', "<th>{m['compliance.ro.efactura.col.unit']()}</th>"],
  ['<th>Weight (kg)</th>', "<th>{m['compliance.ro.etransport.col.weightKg']()}</th>"],
  ['Total weight:', "{m['compliance.ro.etransport.totals.weight']()}:"],
  [' Create Declaration', " {m['compliance.ro.etransport.btn.createDeclaration']()}"],
]);

patch('developer/byod/studio/pages/+page.svelte', [
  [
    'Connect to an external PostgreSQL database, scan its schema, and surface tables as virtual collections in Zveltio.',
    "{m['developer.byod.intro']()}",
  ],
  ['>Connection profiles</button>', ">{m['developer.byod.tab.profiles']()}</button>"],
  ['>Scan history</button>', ">{m['developer.byod.tab.history']()}</button>"],
  ['<th>Schema</th>', "<th>{m['developer.byod.col.schema']()}</th>"],
  ['<th>Last scan</th>', "<th>{m['developer.byod.col.lastScan']()}</th>"],
  ['<th>Tables found</th>', "<th>{m['developer.byod.col.tablesFound']()}</th>"],
  ['<th>Profile</th>', "<th>{m['developer.byod.col.profile']()}</th>"],
  ['<th>Started</th>', "<th>{m['developer.byod.col.started']()}</th>"],
  ['<th>Tables</th>', "<th>{m['developer.byod.col.tables']()}</th>"],
  ["?? 'never'", "?? m['developer.byod.never']()"],
  [
    "{scanning === p.id ? 'Scanning…' : 'Scan'}",
    "{scanning === p.id ? m['developer.byod.btn.scanning']() : m['developer.byod.btn.scan']()}",
  ],
  [
    '<label class="label label-text">Name</label>',
    '<label class="label label-text">{m[\'developer.byod.form.name\']()}</label>',
  ],
  [
    '<label class="label label-text">Connection string</label>',
    '<label class="label label-text">{m[\'developer.byod.form.connectionString\']()}</label>',
  ],
  [
    '<label class="label label-text">Schema</label>',
    '<label class="label label-text">{m[\'developer.byod.form.schema\']()}</label>',
  ],
  [
    '<label class="label label-text">Include patterns (comma-separated)</label>',
    '<label class="label label-text">{m[\'developer.byod.form.includePatterns\']()}</label>',
  ],
  [
    '<label class="label label-text">Exclude patterns</label>',
    '<label class="label label-text">{m[\'developer.byod.form.excludePatterns\']()}</label>',
  ],
  [
    "{saving ? 'Saving…' : m['common.create']()}",
    "{saving ? m['developer.byod.saving']() : m['common.create']()}",
  ],
]);

patch('developer/graphql/studio/pages/+page.svelte', [
  [
    '<Play size={13} class="mr-1.5" /> Playground</button>',
    '<Play size={13} class="mr-1.5" /> {m[\'developer.graphql.tab.playground\']()}</button>',
  ],
  ['>Operation logs</button>', ">{m['developer.graphql.tab.logs']()}</button>"],
  [
    '<Save size={13} class="mr-1.5" /> Persisted queries</button>',
    '<Save size={13} class="mr-1.5" /> {m[\'developer.graphql.tab.persisted\']()}</button>',
  ],
  ['>Field policies</button>', ">{m['developer.graphql.tab.policies']()}</button>"],
  [
    '<span class="font-medium text-sm">Query</span>',
    '<span class="font-medium text-sm">{m[\'developer.graphql.panel.query\']()}</span>',
  ],
  [
    '<div class="p-3 border-b border-base-300 font-medium text-sm">Response</div>',
    '<div class="p-3 border-b border-base-300 font-medium text-sm">{m[\'developer.graphql.panel.response\']()}</div>',
  ],
  ['{/if} Run', "{/if}{m['developer.graphql.btn.run']()}"],
  ["'(run a query to see output)'", "m['developer.graphql.placeholder.output']()"],
  ['<th>Time</th>', "<th>{m['developer.graphql.col.time']()}</th>"],
  ['<th>Operation</th>', "<th>{m['developer.graphql.col.operation']()}</th>"],
  ['<th>User</th>', "<th>{m['developer.graphql.col.user']()}</th>"],
  ['<th>Roles</th>', "<th>{m['developer.graphql.col.roles']()}</th>"],
  ['<th>Mode</th>', "<th>{m['developer.graphql.col.mode']()}</th>"],
  [
    "{l.error ? 'error' : 'ok'}",
    "{l.error ? m['developer.graphql.status.error']() : m['developer.graphql.status.ok']()}",
  ],
  [
    "toast.error(e?.message ?? 'Query failed')",
    "toast.error(e?.message ?? m['developer.graphql.error.queryFailed']())",
  ],
]);

patch('developer/api-docs/studio/pages/+page.svelte', [
  ['>Changelog</button>', ">{m['developer.api-docs.tab.changelog']()}</button>"],
  ['>View OpenAPI spec →</a>', ">{m['developer.api-docs.link.openApi']()}</a>"],
  ['No changelog entries.', "{m['developer.api-docs.empty.changelog']()}"],
  ['<th>Public</th>', "<th>{m['developer.api-docs.col.public']()}</th>"],
  ['<th>Updated</th>', "<th>{m['developer.api-docs.col.updated']()}</th>"],
  ['<th>Token</th>', "<th>{m['developer.api-docs.col.token']()}</th>"],
  ['<th>Last used</th>', "<th>{m['developer.api-docs.col.lastUsed']()}</th>"],
]);

patch('developer/validation/studio/pages/+page.svelte', [
  [
    '<span class="label-text text-xs">Description</span>',
    '<span class="label-text text-xs">{m[\'developer.validation.form.description\']()}</span>',
  ],
]);

patch('developer/database/studio/pages/+page.svelte', [
  [
    '<div class="font-medium text-sm mb-2">Tables ({tables.length})</div>',
    '<div class="font-medium text-sm mb-2">{m[\'developer.database.tables\']()} ({tables.length})</div>',
  ],
  [
    '<li class="p-3 text-base-content/60 text-sm">Loading…</li>',
    '<li class="p-3 text-base-content/60 text-sm">{m[\'developer.database.loading\']()}</li>',
  ],
  [
    '<li class="p-3 text-base-content/60 text-sm">No tables.</li>',
    '<li class="p-3 text-base-content/60 text-sm">{m[\'developer.database.noTables\']()}</li>',
  ],
  [
    '<p class="text-base-content/50 text-sm">Select a table to inspect.</p>',
    '<p class="text-base-content/50 text-sm">{m[\'developer.database.selectTable\']()}</p>',
  ],
  [
    '{rowCount.toLocaleString()} rows · {columns.length} columns',
    "{rowCount.toLocaleString()} {m['developer.database.rows']()} · {columns.length} {m['developer.database.columns']()}",
  ],
  [
    'uppercase tracking-wider">Schema</div>',
    "uppercase tracking-wider\">{m['developer.database.section.schema']()}</div>",
  ],
  ['<th>Column</th>', "<th>{m['developer.database.col.column']()}</th>"],
  ['<th>Nullable</th>', "<th>{m['developer.database.col.nullable']()}</th>"],
  ['<th>Default</th>', "<th>{m['developer.database.col.default']()}</th>"],
  [
    'uppercase tracking-wider">Sample rows</div>',
    "uppercase tracking-wider\">{m['developer.database.section.sampleRows']()}</div>",
  ],
  [
    'text-center py-6 text-base-content/50 text-sm">No rows.</td>',
    "text-center py-6 text-base-content/50 text-sm\">{m['developer.database.noRows']()}</td>",
  ],
  ["? 'yes' : 'no'", "? m['developer.database.yes']() : m['developer.database.no']()"],
]);

patch('developer/views/studio/pages/+page.svelte', [
  [
    '<Plus size={14} /> New view</button>',
    "<Plus size={14} /> {m['developer.views.btn.newView']()}</button>",
  ],
  ['No saved views yet.', "{m['developer.views.empty']()}"],
  [
    "throw new Error('Invalid JSON in config')",
    "throw new Error(m['developer.views.error.invalidJson']())",
  ],
]);

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('i18n-batch-developer-compliance done');
