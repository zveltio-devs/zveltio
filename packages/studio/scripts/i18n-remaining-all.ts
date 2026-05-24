#!/usr/bin/env bun
/**
 * Final pass: remaining i18n strings + shell for pages without ExtensionPageShell.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

function add(k: string, enStr: string, roStr: string) {
  en[k] = enStr;
  ro[k] = roStr;
}

// --- Keys (EN + RO) ---
const KEYS: [string, string, string][] = [
  ['billing.subtitle', 'Plans, subscription, and usage', 'Planuri, abonament și utilizare'],
  ['billing.tab.subscription', 'Subscription', 'Abonament'],
  ['billing.tab.usage', 'Usage', 'Utilizare'],
  ['billing.empty.noSubscription', 'No active subscription. Choose a plan below.', 'Niciun abonament activ. Alege un plan mai jos.'],
  ['billing.badge.current', 'Current', 'Curent'],
  ['billing.btn.upgradeTo', 'Upgrade to', 'Upgrade la'],
  ['billing.metric.apiCalls', 'API Calls', 'Apeluri API'],
  ['billing.metric.storageWrites', 'Storage Writes', 'Scrieri stocare'],
  ['billing.metric.recordsCreated', 'Records Created', 'Înregistrări create'],
  ['billing.usage.percentUsed', '{pct}% used', '{pct}% utilizat'],
  ['search.title', 'Search', 'Căutare'],
  ['search.subtitle', 'Full-text and semantic search indexes', 'Indexuri căutare full-text și semantică'],
  ['search.resultsCount', '{n} results', '{n} rezultate'],
  ['search.empty.indexes', 'No search indexes configured.', 'Niciun index de căutare configurat.'],
  ['search.btn.save', 'Save', 'Salvează'],
  ['auth.ldap.title', 'LDAP', 'LDAP'],
  ['auth.ldap.subtitle', 'Directory authentication settings', 'Setări autentificare director'],
  ['auth.ldap.section.enable', 'Enable LDAP Authentication', 'Activează autentificare LDAP'],
  ['auth.ldap.section.server', 'Server Connection', 'Conexiune server'],
  ['auth.ldap.section.tls', 'Verify TLS certificate', 'Verifică certificat TLS'],
  ['auth.ldap.section.search', 'Search Settings', 'Setări căutare'],
  ['auth.ldap.btn.test', 'Test Connection', 'Testează conexiunea'],
  ['auth.ldap.placeholder.username', 'Use {{username}} as placeholder for the login value', 'Folosește {{username}} ca placeholder pentru login'],
  ['auth.saml.title', 'SAML SSO', 'SAML SSO'],
  ['auth.saml.subtitle', 'Single sign-on with identity provider', 'Single sign-on cu furnizor identitate'],
  ['auth.saml.section.sp', 'Service Provider Info', 'Info Service Provider'],
  ['auth.saml.section.idp', 'Identity Provider Settings', 'Setări Identity Provider'],
  ['auth.saml.enable', 'Enable SAML SSO', 'Activează SAML SSO'],
  ['auth.saml.btn.save', 'Save Configuration', 'Salvează configurarea'],
  ['sms.title', 'SMS', 'SMS'],
  ['sms.subtitle', 'Send messages and manage templates', 'Trimite mesaje și gestionează șabloane'],
  ['sms.btn.send', 'Send SMS', 'Trimite SMS'],
  ['sms.col.body', 'Body', 'Conținut'],
  ['sms.col.sentAt', 'Sent at', 'Trimis la'],
  ['sms.col.provider', 'Provider', 'Furnizor'],
  ['sms.btn.saveTemplate', 'Save Template', 'Salvează șablon'],
  ['sms.placeholder.body', 'Body (use {{name}} for interpolation)', 'Conținut (folosește {{name}} pentru interpolare)'],
  ['content.media.title', 'Media Library', 'Bibliotecă media'],
  ['content.media.tab.allFiles', 'All Files', 'Toate fișierele'],
  ['content.media.filesCount', '{n} files', '{n} fișiere'],
  ['content.media.btn.upload', 'Upload', 'Încarcă'],
  ['content.media.btn.selectAll', 'Select all', 'Selectează tot'],
  ['content.media.uploadFiles', 'Upload {n} file(s)', 'Încarcă {n} fișier(e)'],
  ['content.media.btn.download', 'Download', 'Descarcă'],
  ['content.media.empty.folder', 'Empty folder. Drag files here or click Upload.', 'Folder gol. Trage fișiere sau apasă Încarcă.'],
  ['developer.validation.title', 'Data Validation', 'Validare date'],
  ['developer.validation.subtitle', 'Field-level validation with AI assistance', 'Validare la nivel de câmp cu asistență AI'],
  ['compliance.gdpr.tab.requests', 'Access requests', 'Cereri acces'],
  ['compliance.gdpr.tab.breaches', 'Breaches', 'Încălcări'],
  ['compliance.gdpr.tab.consents', 'Consents', 'Consimțăminte'],
  ['compliance.gdpr.tab.records', 'Processing records', 'Înregistrări prelucrare'],
  ['compliance.gdpr.col.requested', 'Requested', 'Solicitat'],
  ['compliance.gdpr.col.severity', 'Severity', 'Severitate'],
  ['compliance.gdpr.col.affected', 'Affected', 'Afectați'],
  ['compliance.gdpr.col.notifiedDpa', 'Notified DPA', 'Notificat ANSPDCP'],
  ['compliance.gdpr.col.purpose', 'Purpose', 'Scop'],
  ['compliance.gdpr.col.granted', 'Granted', 'Acordat'],
  ['compliance.gdpr.col.withdrawn', 'Withdrawn', 'Retras'],
  ['compliance.gdpr.col.activity', 'Activity', 'Activitate'],
  ['compliance.gdpr.col.lawfulBasis', 'Lawful basis', 'Temei legal'],
  ['compliance.gdpr.col.categories', 'Categories', 'Categorii'],
  ['compliance.gdpr.col.retention', 'Retention', 'Retenție'],
  ['compliance.ro.documents.btn.new', 'New document', 'Document nou'],
  ['compliance.ro.documents.col.type', 'Type', 'Tip'],
  ['compliance.ro.documents.col.data', 'Date', 'Dată'],
  ['compliance.ro.documents.col.title', 'Title', 'Titlu'],
  ['compliance.ro.documents.col.signed', 'Signed', 'Semnat'],
  ['compliance.ro.documents.col.parties', 'Parties', 'Părți'],
  ['compliance.ro.documents.btn.create', 'Create', 'Creează'],
  ['compliance.ro.procurement.tab.orders', 'Orders', 'Comenzi'],
  ['compliance.ro.procurement.tab.suppliers', 'Suppliers', 'Furnizori'],
  ['compliance.ro.procurement.btn.newOrder', 'New order', 'Comandă nouă'],
  ['compliance.ro.procurement.btn.newSupplier', 'New supplier', 'Furnizor nou'],
  ['compliance.ro.procurement.col.budget', 'Budget', 'Buget'],
  ['compliance.ro.procurement.col.supplier', 'Supplier', 'Furnizor'],
  ['compliance.ro.procurement.col.reception', 'Reception', 'Recepție'],
  ['compliance.ro.procurement.col.article', 'Item', 'Articol'],
  ['compliance.ro.procurement.col.qty', 'Qty', 'Cant.'],
  ['compliance.ro.procurement.col.unitPrice', 'Unit price', 'Preț unitar'],
  ['compliance.ro.procurement.btn.createOrder', 'Create order', 'Creează comandă'],
  ['compliance.ro.procurement.btn.record', 'Record', 'Înregistrare'],
  ['content.documents.tab.generated', 'Generated Documents', 'Documente generate'],
  ['content.documents.tab.templates', 'Templates', 'Șabloane'],
  ['content.documents.empty', 'No documents yet. Generate one from a template.', 'Nicio document încă. Generează dintr-un șablon.'],
  ['content.documents.col.filename', 'Filename', 'Nume fișier'],
  ['content.documents.col.signed', 'Signed', 'Semnat'],
  ['content.documents.empty.templates', 'No templates available', 'Niciun șablon disponibil'],
  ['content.documents.col.variable', 'variable', 'variabilă'],
  ['content.documents.btn.generate', 'Generate', 'Generează'],
  ['content.documents.empty.noVariables', 'No variables needed for this template.', 'Nu sunt variabile pentru acest șablon.'],
  ['content.documents.btn.send', 'Send', 'Trimite'],
  ['content.documents.btn.requestSignature', 'Request signature', 'Solicită semnătură'],
  ['content.documents.btn.viewLink', 'View shared link', 'Vezi link partajat'],
  ['content.documents.generateLabel', 'Generate:', 'Generează:'],
  ['content.drafts.col.record', 'Record', 'Înregistrare'],
  ['content.drafts.col.author', 'Author', 'Autor'],
  ['content.drafts.col.updated', 'Updated', 'Actualizat'],
  ['content.drafts.btn.publish', 'Publish', 'Publică'],
  ['content.document-templates.col.format', 'Format', 'Format'],
  ['content.document-templates.placeholder.template', 'template', 'șablon'],
  ['content.document-templates.format.docx', 'DOCX', 'DOCX'],
  ['content.document-templates.col.description', 'Description', 'Descriere'],
  ['content.document-templates.bodyHint', 'Body — use {{var}} for substitution', 'Conținut — folosește {{var}} pentru substituție'],
  ['data.export.col.time', 'Time', 'Ora'],
  ['data.export.col.format', 'Format', 'Format'],
  ['data.export.col.rows', 'Rows', 'Rânduri'],
  ['data.export.col.size', 'Size', 'Dimensiune'],
  ['data.export.col.user', 'User', 'Utilizator'],
  ['data.export.col.collection', 'Collection', 'Colecție'],
  ['data.export.filterHint', 'Filter (Zveltio query, optional)', 'Filtru (query Zveltio, opțional)'],
  ['data.export.btn.download', 'Download', 'Descarcă'],
  ['data.import.col.time', 'Time', 'Ora'],
  ['data.import.col.format', 'Format', 'Format'],
  ['data.import.col.rows', 'Rows', 'Rânduri'],
  ['data.import.col.errors', 'Errors', 'Erori'],
  ['data.import.dropHint', 'Drag a CSV / JSON / NDJSON file, or click to browse', 'Trage CSV / JSON / NDJSON sau click pentru browse'],
  ['data.import.upsertHint', 'Upsert on field (optional, e.g. email)', 'Upsert pe câmp (opțional, ex. email)'],
  ['data.import.toast.imported', 'Imported {n} rows', 'Importate {n} rânduri'],
  ['data.import.errorsHint', '{n} errors — see job log', '{n} erori — vezi jurnal'],
  ['data.import.selectPlaceholder', '— Select —', '— Selectează —'],
  ['developer.api-docs.btn.newPage', 'New page', 'Pagină nouă'],
  ['developer.api-docs.btn.generateToken', 'Generate token', 'Generează token'],
  ['developer.api-docs.tab.customPages', 'Custom pages', 'Pagini custom'],
  ['developer.api-docs.tab.tokens', 'Access tokens', 'Token-uri acces'],
  ['developer.api-docs.btn.create', 'Create', 'Creează'],
  ['developer.database.showingRows', 'Showing first 50 of {n}.', 'Primele 50 din {n}.'],
  ['finance.quotes.btn.new', 'New Quote', 'Ofertă nouă'],
  ['finance.quotes.section.lines', 'Lines', 'Linii'],
  ['finance.quotes.btn.addLine', 'Add line', 'Adaugă linie'],
  ['finance.quotes.btn.create', 'Create Quote', 'Creează ofertă'],
  ['finance.quotes.btn.send', 'Send', 'Trimite'],
  ['finance.quotes.btn.accept', 'Mark accepted', 'Marchează acceptată'],
  ['finance.subscriptions.col.code', 'Code', 'Cod'],
  ['finance.subscriptions.col.name', 'Name', 'Nume'],
  ['geospatial.postgis.tab.proximity', 'Proximity Search', 'Căutare proximitate'],
  ['geospatial.postgis.tab.geofences', 'Geofences ({n})', 'Geofence ({n})'],
  ['geospatial.postgis.tab.clustering', 'Clustering', 'Clustering'],
  ['geospatial.postgis.btn.search', 'Search', 'Caută'],
  ['geospatial.postgis.resultsAway', '{n} results · {d} m away', '{n} rezultate · {d} m distanță'],
  ['geospatial.postgis.btn.create', 'Create', 'Creează'],
  ['geospatial.postgis.empty.geofences', 'No geofences yet.', 'Niciun geofence încă.'],
  ['geospatial.postgis.clusterHint', 'Use POST /ext/geospatial/postgis/cluster — returns clusters with centroid and counts.', 'Folosește POST /ext/geospatial/postgis/cluster — returnează clustere cu centroid.'],
  ['geospatial.postgis.col.collection', 'Collection', 'Colecție'],
  ['hr.payroll.btn.newPeriod', 'New period', 'Perioadă nouă'],
  ['hr.payroll.tab.periods', 'Periods', 'Perioade'],
  ['hr.payroll.empty.periods', 'No periods yet.', 'Nicio perioadă încă.'],
  ['hr.payroll.selectPeriod', 'Select a period to view payroll entries.', 'Selectează o perioadă pentru înregistrări salarizare.'],
  ['hr.payroll.btn.generate', 'Generate', 'Generează'],
  ['hr.payroll.btn.revisal', 'Revisal XML', 'XML Revisal'],
  ['hr.payroll.col.gross', 'Gross', 'Brut'],
  ['hr.payroll.col.net', 'Net', 'Net'],
  ['i18n.translations.tab.keys', 'Keys', 'Chei'],
  ['i18n.translations.tab.locales', 'Locales', 'Locale'],
  ['i18n.translations.tab.glossary', 'Glossary', 'Glosar'],
  ['i18n.translations.col.term', 'Term', 'Termen'],
  ['i18n.translations.col.translation', 'Translation', 'Traducere'],
  ['i18n.translations.col.context', 'Context', 'Context'],
  ['i18n.translations.col.localeCode', 'Code (e.g. ro, en, de)', 'Cod (ex. ro, en, de)'],
  ['i18n.translations.col.localeName', 'Name', 'Nume'],
  ['i18n.translations.btn.search', 'Search', 'Caută'],
  ['integrations.api-connector.btn.new', 'New connection', 'Conexiune nouă'],
  ['integrations.api-connector.tab.connections', 'Connections', 'Conexiuni'],
  ['integrations.api-connector.tab.webhooks', 'Incoming webhooks', 'Webhook-uri primite'],
  ['integrations.api-connector.tab.logs', 'Call logs', 'Jurnal apeluri'],
  ['integrations.api-connector.empty.connections', 'No external API connections yet.', 'Nicio conexiune API externă.'],
  ['integrations.api-connector.col.url', 'URL', 'URL'],
  ['integrations.api-connector.col.lastReceived', 'Last received', 'Ultima primire'],
  ['integrations.api-connector.col.time', 'Time', 'Ora'],
  ['integrations.api-connector.col.connection', 'Connection', 'Conexiune'],
  ['integrations.api-connector.btn.create', 'Create', 'Creează'],
  ['operations.assets.btn.new', 'New Asset', 'Activ nou'],
  ['operations.assets.empty', 'No assets registered yet.', 'Niciun activ înregistrat.'],
  ['operations.assets.col.location', 'Location', 'Locație'],
  ['operations.assets.col.cost', 'Cost', 'Cost'],
  ['operations.assets.btn.create', 'Create', 'Creează'],
  ['projects.helpdesk.btn.new', 'New ticket', 'Tichet nou'],
  ['projects.helpdesk.empty.select', 'Select a ticket to view the conversation.', 'Selectează un tichet pentru conversație.'],
  ['projects.helpdesk.btn.create', 'Create', 'Creează'],
  ['projects.helpdesk.col.category', 'Category', 'Categorie'],
  ['projects.helpdesk.priority.low', 'Low', 'Scăzută'],
  ['projects.helpdesk.priority.high', 'High', 'Ridicată'],
  ['projects.management.btn.newProject', 'New project', 'Proiect nou'],
  ['projects.management.empty.projects', 'No projects yet.', 'Niciun proiect încă.'],
  ['projects.management.btn.newTask', 'New task', 'Task nou'],
  ['projects.management.col.dueDate', 'Due date', 'Termen'],
  ['projects.management.col.assignee', 'Assignee', 'Responsabil'],
  ['projects.management.col.status', 'Status', 'Status'],
  ['projects.management.col.priority', 'Priority', 'Prioritate'],
  ['projects.management.priority.low', 'Low', 'Scăzută'],
  ['projects.management.priority.medium', 'Medium', 'Medie'],
  ['projects.management.priority.high', 'High', 'Ridicată'],
  ['projects.management.priority.urgent', 'Urgent', 'Urgent'],
  ['projects.management.form.name', 'Name *', 'Nume *'],
  ['projects.management.form.title', 'Title *', 'Titlu *'],
  ['analytics.quality.tab.history', 'Scan history', 'Istoric scanări'],
  ['analytics.quality.tab.issues', 'Issues', 'Probleme'],
  ['analytics.quality.col.severity', 'Severity', 'Severitate'],
  ['workflow.checklists.btn.create', 'Create', 'Creează'],
  ['workflow.checklists.col.item', 'item', 'element'],
  ['workflow.checklists.tab.responses', 'Responses', 'Răspunsuri'],
  ['workflow.checklists.btn.edit', 'Edit', 'Editează'],
  ['workflow.checklists.col.items', 'Items', 'Elemente'],
  ['workflow.checklists.col.required', 'Required', 'Obligatoriu'],
  ['workflow.checklists.empty.items', 'No items yet. Add some below.', 'Niciun element. Adaugă mai jos.'],
  ['workflow.checklists.btn.add', 'Add', 'Adaugă'],
  ['workflow.checklists.empty.responses', 'No responses yet', 'Niciun răspuns încă'],
  ['workflow.checklists.col.submittedBy', 'Submitted by', 'Trimis de'],
  ['workflow.checklists.col.answers', 'Answers', 'Răspunsuri'],
  ['storage.cloud.empty.folder', 'Empty folder. Drag files here or click Upload.', 'Folder gol. Trage fișiere sau apasă Încarcă.'],
  ['storage.cloud.btn.share', 'Share', 'Partajează'],
  ['content.page-builder.section.settings', 'Page Settings', 'Setări pagină'],
  ['ai.title', 'AI', 'AI'],
  ['ai.subtitle', 'Providers, chat, search, SQL, and schema tools', 'Furnizori, chat, căutare, SQL și scheme'],
];

for (const [k, e, r] of KEYS) add(k, e, r);

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

function ensureMImport(c: string): string {
  if (c.includes("from '$lib/i18n")) return c;
  return c.replace(/<script lang="ts">\n/, "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n");
}

function wrapSimple(rel: string, titleKey: string, subtitleKey: string, wrapperClass = 'space-y-4') {
  const p = join(EXT, rel);
  if (!existsSync(p) || readFileSync(p, 'utf8').includes('<ExtensionPageShell')) return;
  let c = ensureMImport(readFileSync(p, 'utf8'));
  if (!c.includes("ExtensionPageShell")) {
    c = c.replace(
      /<script lang="ts">\n/,
      "<script lang=\"ts\">\n  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';\n",
    );
  }
  const marker = `<div class="${wrapperClass}">`;
  const idx = c.indexOf(marker);
  if (idx < 0) return;
  // extract inner using depth
  let depth = 0;
  let i = idx;
  while (i < c.length) {
    if (c.startsWith('<div', i)) depth++;
    else if (c.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) {
        const inner = c.slice(idx + marker.length, i);
        const after = c.slice(i + '</div>'.length);
        const sub = subtitleKey ? ` subtitle={m['${subtitleKey}']()}` : '';
        c =
          c.slice(0, idx) +
          `<ExtensionPageShell title={m['${titleKey}']()}${sub}>
  {#snippet children()}
${inner.trim()}
  {/snippet}
</ExtensionPageShell>` +
          after;
        writeFileSync(p, c);
        console.log('wrapped', rel);
        return;
      }
    }
    i++;
  }
}

// --- Patches ---
patch('compliance/gdpr/studio/pages/+page.svelte', [
  ['> Access requests\n', '>{m[\'compliance.gdpr.tab.requests\']()}\n'],
  ['> Breaches\n', '>{m[\'compliance.gdpr.tab.breaches\']()}\n'],
  ['>Consents</button>', '>{m[\'compliance.gdpr.tab.consents\']()}</button>'],
  ['> Processing records\n', '>{m[\'compliance.gdpr.tab.records\']()}\n'],
  ['<th>Requested</th>', '<th>{m[\'compliance.gdpr.col.requested\']()}</th>'],
  ['<th>Severity</th>', '<th>{m[\'compliance.gdpr.col.severity\']()}</th>'],
  ['<th>Affected</th>', '<th>{m[\'compliance.gdpr.col.affected\']()}</th>'],
  ['<th>Notified DPA</th>', '<th>{m[\'compliance.gdpr.col.notifiedDpa\']()}</th>'],
  ['<th>Purpose</th>', '<th>{m[\'compliance.gdpr.col.purpose\']()}</th>'],
  ['<th>Granted</th>', '<th>{m[\'compliance.gdpr.col.granted\']()}</th>'],
  ['<th>Withdrawn</th>', '<th>{m[\'compliance.gdpr.col.withdrawn\']()}</th>'],
  ['<th>Activity</th>', '<th>{m[\'compliance.gdpr.col.activity\']()}</th>'],
  ['<th>Lawful basis</th>', '<th>{m[\'compliance.gdpr.col.lawfulBasis\']()}</th>'],
  ['<th>Categories</th>', '<th>{m[\'compliance.gdpr.col.categories\']()}</th>'],
  ['<th>Retention</th>', '<th>{m[\'compliance.gdpr.col.retention\']()}</th>'],
]);

patch('auth/ldap/studio/pages/+page.svelte', [
  ['<span class="text-sm">Enable LDAP Authentication</span>', '<span class="text-sm">{m[\'auth.ldap.section.enable\']()}</span>'],
  ['>Server Connection</div>', '>{m[\'auth.ldap.section.server\']()}</div>'],
  ['>Verify TLS certificate</span>', '>{m[\'auth.ldap.section.tls\']()}</span>'],
  ['>Search Settings</div>', '>{m[\'auth.ldap.section.search\']()}</div>'],
  ['>Test Connection\n', '>{m[\'auth.ldap.btn.test\']()}\n'],
  ['Use {{username}} as placeholder for the login value', '{m[\'auth.ldap.placeholder.username\']()}'],
]);

patch('search/studio/pages/+page.svelte', [
  ['<h1 class="text-xl font-semibold">Search</h1>', '<h1 class="text-xl font-semibold">{m[\'search.title\']()}</h1>'],
  ['Full-text and semantic search indexes', '{m[\'search.subtitle\']()}'],
  ['{results.length} results', '{m[\'search.resultsCount\']({ n: String(getResultRows().length) })}'],
  ['No search indexes configured.', '{m[\'search.empty.indexes\']()}'],
  ['>Save</button>', '>{m[\'search.btn.save\']()}</button>'],
]);

patch('billing/studio/pages/+page.svelte', []); // rewritten above

// LDAP / SAML shell: strip duplicate h1, wrap
function wrapLdapSaml(rel: string, titleKey: string, subtitleKey: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  if (c.includes('<ExtensionPageShell')) return;
  c = ensureMImport(c);
  if (!c.includes('ExtensionPageShell')) {
    c = c.replace(
      /<script lang="ts">\n/,
      "<script lang=\"ts\">\n  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';\n",
    );
  }
  c = c.replace(
    /\s*<div>\s*<h1 class="text-xl font-semibold">\{m\['[^']+'\]\(\)\}<\/h1>\s*<p class="text-sm text-base-content\/50">\{m\['[^']+'\]\(\)\}<\/p>\s*<\/div>\s*/,
    '\n',
  );
  const marker = '<div class="max-w-2xl space-y-6">';
  const idx = c.indexOf(marker);
  if (idx < 0) return;
  let depth = 0;
  let i = idx;
  while (i < c.length) {
    if (c.startsWith('<div', i)) depth++;
    else if (c.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) {
        const inner = c.slice(idx + marker.length, i);
        const after = c.slice(i + '</div>'.length);
        c =
          c.slice(0, idx) +
          `<ExtensionPageShell title={m['${titleKey}']()} subtitle={m['${subtitleKey}']()}>\n  {#snippet children()}\n    <div class="max-w-2xl space-y-6">\n${inner.trim()}\n    </div>\n  {/snippet}\n</ExtensionPageShell>` +
          after;
        writeFileSync(p, c);
        console.log('wrapped', rel);
        return;
      }
    }
    i++;
  }
}

wrapLdapSaml('auth/ldap/studio/pages/+page.svelte', 'auth.ldap.title', 'auth.ldap.subtitle');
wrapLdapSaml('auth/saml/studio/pages/+page.svelte', 'auth.saml.title', 'auth.saml.subtitle');

wrapSimple('search/studio/pages/+page.svelte', 'search.title', 'search.subtitle');
// search may have h1 inside - remove if wrap failed
{
  const p = join(EXT, 'search/studio/pages/+page.svelte');
  if (existsSync(p)) {
    let c = readFileSync(p, 'utf8');
    const n = c.replace(/\s*<div class="flex items-center justify-between">\s*<div>\s*<h1[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*/, '\n');
    if (n !== c) {
      writeFileSync(p, n);
      console.log('search header stripped');
    }
  }
}

wrapSimple('sms/studio/pages/+page.svelte', 'sms.title', 'sms.subtitle');
wrapSimple('workflow/checklists/studio/pages/+page.svelte', 'workflow.checklists.title', 'workflow.checklists.subtitle', 'space-y-6');

const MORE: [string, string, string][] = [
  ['auth.saml.section.sp', 'Service Provider Info', 'Info Service Provider'],
  ['auth.saml.section.idp', 'Identity Provider Settings', 'Setări Identity Provider'],
  ['auth.saml.enable', 'Enable SAML SSO', 'Activează SAML SSO'],
  ['auth.saml.btn.save', 'Save Configuration', 'Salvează configurarea'],
];
for (const [k, e, r] of MORE) add(k, e, r);

patch('auth/saml/studio/pages/+page.svelte', [
  ['>Service Provider Info</div>', '>{m[\'auth.saml.section.sp\']()}</div>'],
  ['>Identity Provider Settings</div>', '>{m[\'auth.saml.section.idp\']()}</div>'],
  ['Enable SAML SSO', '{m[\'auth.saml.enable\']()}'],
  ['>Save Configuration\n', '>{m[\'auth.saml.btn.save\']()}\n'],
]);

patch('sms/studio/pages/+page.svelte', [
  ['>Send SMS\n', '>{m[\'sms.btn.send\']()}\n'],
  ['<th>Body</th>', '<th>{m[\'sms.col.body\']()}</th>'],
  ['<th>Sent at</th>', '<th>{m[\'sms.col.sentAt\']()}</th>'],
  ['<th>Provider</th>', '<th>{m[\'sms.col.provider\']()}</th>'],
  ['>Save Template\n', '>{m[\'sms.btn.saveTemplate\']()}\n'],
  ['Body (use {{name}} for interpolation)', '{m[\'sms.placeholder.body\']()}'],
]);

patch('content/media/studio/pages/+page.svelte', [
  ['>All Files\n', '>{m[\'content.media.tab.allFiles\']()}\n'],
  ['{files.length} files', '{m[\'content.media.filesCount\']({ n: String(files.length) })}'],
  ['>Upload\n', '>{m[\'content.media.btn.upload\']()}\n'],
  ['>Select all\n', '>{m[\'content.media.btn.selectAll\']()}\n'],
  ['>Download\n', '>{m[\'content.media.btn.download\']()}\n'],
  ['Empty folder. Drag files here or click Upload.', '{m[\'content.media.empty.folder\']()}'],
]);

patch('compliance/ro/documents/studio/pages/+page.svelte', [
  ['>New document\n', '>{m[\'compliance.ro.documents.btn.new\']()}\n'],
  ['<th>Type</th>', '<th>{m[\'compliance.ro.documents.col.type\']()}</th>'],
  ['<th>Date</th>', '<th>{m[\'compliance.ro.documents.col.data\']()}</th>'],
  ['<th>Title</th>', '<th>{m[\'compliance.ro.documents.col.title\']()}</th>'],
  ['<th>Signed</th>', '<th>{m[\'compliance.ro.documents.col.signed\']()}</th>'],
  ['<th>Parties</th>', '<th>{m[\'compliance.ro.documents.col.parties\']()}</th>'],
  ['>Create\n', '>{m[\'compliance.ro.documents.btn.create\']()}\n'],
]);

patch('compliance/ro/procurement/studio/pages/+page.svelte', [
  ['>Orders\n', '>{m[\'compliance.ro.procurement.tab.orders\']()}\n'],
  ['>Suppliers\n', '>{m[\'compliance.ro.procurement.tab.suppliers\']()}\n'],
  ['>New order\n', '>{m[\'compliance.ro.procurement.btn.newOrder\']()}\n'],
  ['>New supplier\n', '>{m[\'compliance.ro.procurement.btn.newSupplier\']()}\n'],
  ['<th>Budget</th>', '<th>{m[\'compliance.ro.procurement.col.budget\']()}</th>'],
  ['<th>Supplier</th>', '<th>{m[\'compliance.ro.procurement.col.supplier\']()}</th>'],
  ['<th>Reception</th>', '<th>{m[\'compliance.ro.procurement.col.reception\']()}</th>'],
  ['<th>Item</th>', '<th>{m[\'compliance.ro.procurement.col.article\']()}</th>'],
  ['<th>Qty</th>', '<th>{m[\'compliance.ro.procurement.col.qty\']()}</th>'],
  ['<th>Unit price</th>', '<th>{m[\'compliance.ro.procurement.col.unitPrice\']()}</th>'],
  ['>Create order\n', '>{m[\'compliance.ro.procurement.btn.createOrder\']()}\n'],
  ['>Record\n', '>{m[\'compliance.ro.procurement.btn.record\']()}\n'],
]);

patch('content/documents/studio/pages/+page.svelte', [
  ['>Generated Documents\n', '>{m[\'content.documents.tab.generated\']()}\n'],
  ['>Templates\n', '>{m[\'content.documents.tab.templates\']()}\n'],
  ['No documents yet. Generate one from a template.', '{m[\'content.documents.empty\']()}'],
  ['<th>Filename</th>', '<th>{m[\'content.documents.col.filename\']()}</th>'],
  ['<th>Signed</th>', '<th>{m[\'content.documents.col.signed\']()}</th>'],
  ['No templates available', '{m[\'content.documents.empty.templates\']()}'],
  ['>variable</th>', '>{m[\'content.documents.col.variable\']()}</th>'],
  ['>Generate\n', '>{m[\'content.documents.btn.generate\']()}\n'],
  ['No variables needed for this template.', '{m[\'content.documents.empty.noVariables\']()}'],
  ['>Send\n', '>{m[\'content.documents.btn.send\']()}\n'],
  ['>Request signature\n', '>{m[\'content.documents.btn.requestSignature\']()}\n'],
  ['>View shared link\n', '>{m[\'content.documents.btn.viewLink\']()}\n'],
  ['Generate:', '{m[\'content.documents.generateLabel\']()}'],
]);

patch('data/export/studio/pages/+page.svelte', [
  ['<th>Time</th>', '<th>{m[\'data.export.col.time\']()}</th>'],
  ['<th>Format</th>', '<th>{m[\'data.export.col.format\']()}</th>'],
  ['<th>Rows</th>', '<th>{m[\'data.export.col.rows\']()}</th>'],
  ['<th>Size</th>', '<th>{m[\'data.export.col.size\']()}</th>'],
  ['<th>User</th>', '<th>{m[\'data.export.col.user\']()}</th>'],
  ['<th>Collection</th>', '<th>{m[\'data.export.col.collection\']()}</th>'],
  ['Filter (Zveltio query, optional)', '{m[\'data.export.filterHint\']()}'],
  ['>Download\n', '>{m[\'data.export.btn.download\']()}\n'],
]);

patch('data/import/studio/pages/+page.svelte', [
  ['<th>Time</th>', '<th>{m[\'data.import.col.time\']()}</th>'],
  ['<th>Format</th>', '<th>{m[\'data.import.col.format\']()}</th>'],
  ['<th>Rows</th>', '<th>{m[\'data.import.col.rows\']()}</th>'],
  ['<th>Errors</th>', '<th>{m[\'data.import.col.errors\']()}</th>'],
  ['Drag a CSV / JSON / NDJSON file, or click to browse', '{m[\'data.import.dropHint\']()}'],
  ['Upsert on field (optional, e.g. email)', '{m[\'data.import.upsertHint\']()}'],
  ["toast.success(`Imported ${res.imported} rows`)", "toast.success(m['data.import.toast.imported']({ n: String(res.imported) }))"],
  ['` · ${res.errors} errors — see job log`', "m['data.import.errorsHint']({ n: String(res.errors) })"],
  ['>— Select —</option>', '>{m[\'data.import.selectPlaceholder\']()}</option>'],
]);

patch('geospatial/postgis/studio/pages/+page.svelte', [
  ['>Proximity Search\n', '>{m[\'geospatial.postgis.tab.proximity\']()}\n'],
  ['>Search\n', '>{m[\'geospatial.postgis.btn.search\']()}\n'],
  ['>Create\n', '>{m[\'geospatial.postgis.btn.create\']()}\n'],
  ['No geofences yet.', '{m[\'geospatial.postgis.empty.geofences\']()}'],
  ['Use POST /ext/geospatial/postgis/cluster', '{m[\'geospatial.postgis.clusterHint\']()}'],
  ['<th>Collection</th>', '<th>{m[\'geospatial.postgis.col.collection\']()}</th>'],
]);

patch('hr/payroll/studio/pages/+page.svelte', [
  ['>New period\n', '>{m[\'hr.payroll.btn.newPeriod\']()}\n'],
  ['>Periods\n', '>{m[\'hr.payroll.tab.periods\']()}\n'],
  ['No periods yet.', '{m[\'hr.payroll.empty.periods\']()}'],
  ['Select a period to view payroll entries.', '{m[\'hr.payroll.selectPeriod\']()}'],
  ['>Generate\n', '>{m[\'hr.payroll.btn.generate\']()}\n'],
  ['>Revisal XML\n', '>{m[\'hr.payroll.btn.revisal\']()}\n'],
  ['<th>Gross</th>', '<th>{m[\'hr.payroll.col.gross\']()}</th>'],
  ['<th>Net</th>', '<th>{m[\'hr.payroll.col.net\']()}</th>'],
]);

patch('i18n/translations/studio/pages/+page.svelte', [
  ['>Keys\n', '>{m[\'i18n.translations.tab.keys\']()}\n'],
  ['>Locales\n', '>{m[\'i18n.translations.tab.locales\']()}\n'],
  ['>Glossary\n', '>{m[\'i18n.translations.tab.glossary\']()}\n'],
  ['<th>Term</th>', '<th>{m[\'i18n.translations.col.term\']()}</th>'],
  ['<th>Translation</th>', '<th>{m[\'i18n.translations.col.translation\']()}</th>'],
  ['<th>Context</th>', '<th>{m[\'i18n.translations.col.context\']()}</th>'],
  ['Code (e.g. ro, en, de)', '{m[\'i18n.translations.col.localeCode\']()}'],
  ['<th>Name</th>', '<th>{m[\'i18n.translations.col.localeName\']()}</th>'],
  ['>Search\n', '>{m[\'i18n.translations.btn.search\']()}\n'],
]);

patch('projects/management/studio/pages/+page.svelte', [
  ['>New project\n', '>{m[\'projects.management.btn.newProject\']()}\n'],
  ['No projects yet.', '{m[\'projects.management.empty.projects\']()}'],
  ['>New task\n', '>{m[\'projects.management.btn.newTask\']()}\n'],
  ['<th>Due date</th>', '<th>{m[\'projects.management.col.dueDate\']()}</th>'],
  ['<th>Assignee</th>', '<th>{m[\'projects.management.col.assignee\']()}</th>'],
  ['<th>Status</th>', '<th>{m[\'projects.management.col.status\']()}</th>'],
  ['<th>Priority</th>', '<th>{m[\'projects.management.col.priority\']()}</th>'],
  ['>Low</option>', '>{m[\'projects.management.priority.low\']()}</option>'],
  ['>Medium</option>', '>{m[\'projects.management.priority.medium\']()}</option>'],
  ['>High</option>', '>{m[\'projects.management.priority.high\']()}</option>'],
  ['>Urgent</option>', '>{m[\'projects.management.priority.urgent\']()}</option>'],
  ['>Name *</span>', '>{m[\'projects.management.form.name\']()}</span>'],
  ['>Title *</span>', '>{m[\'projects.management.form.title\']()}</span>'],
]);

patch('workflow/checklists/studio/pages/+page.svelte', [
  ['>Create\n', '>{m[\'workflow.checklists.btn.create\']()}\n'],
  ['>item</th>', '>{m[\'workflow.checklists.col.item\']()}</th>'],
  ['>Responses\n', '>{m[\'workflow.checklists.tab.responses\']()}\n'],
  ['>Edit\n', '>{m[\'workflow.checklists.btn.edit\']()}\n'],
  ['<th>Items</th>', '<th>{m[\'workflow.checklists.col.items\']()}</th>'],
  ['<th>Required</th>', '<th>{m[\'workflow.checklists.col.required\']()}</th>'],
  ['No items yet. Add some below.', '{m[\'workflow.checklists.empty.items\']()}'],
  ['>Add\n', '>{m[\'workflow.checklists.btn.add\']()}\n'],
  ['No responses yet', '{m[\'workflow.checklists.empty.responses\']()}'],
  ['<th>Submitted by</th>', '<th>{m[\'workflow.checklists.col.submittedBy\']()}</th>'],
  ['<th>Answers</th>', '<th>{m[\'workflow.checklists.col.answers\']()}</th>'],
]);

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('keys total', Object.keys(en).length);
