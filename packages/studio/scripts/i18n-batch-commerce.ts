#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '../../../zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

const KEYS: Record<string, { en: string; ro: string }> = {
  'operations.pos.session.open': { en: 'Session open', ro: 'Sesiune deschisă' },
  'operations.pos.session.openingFloat': { en: 'Opening float:', ro: 'Fund inițial:' },
  'operations.pos.session.noOpen': { en: 'No open session.', ro: 'Nicio sesiune deschisă.' },
  'operations.pos.recentOrders': { en: 'Recent orders', ro: 'Comenzi recente' },
  'operations.pos.col.time': { en: 'Time', ro: 'Ora' },
  'operations.pos.zReports': { en: 'Recent Z-reports', ro: 'Rapoarte Z recente' },
  'operations.pos.col.sales': { en: 'Sales', ro: 'Vânzări' },
  'operations.pos.col.orderCount': { en: 'Orders', ro: 'Comenzi' },
  'developer.validation.title': { en: 'Data validation rules', ro: 'Reguli de validare date' },
  'developer.validation.subtitle': {
    en: 'Field-level validation with AI assistance',
    ro: 'Validare la nivel de câmp cu asistență AI',
  },
  'developer.validation.newRule': { en: 'New rule', ro: 'Regulă nouă' },
  'developer.validation.allCollections': { en: 'All collections', ro: 'Toate colecțiile' },
  'developer.validation.col.ruleType': { en: 'Rule type', ro: 'Tip regulă' },
  'developer.validation.col.severity': { en: 'Severity', ro: 'Severitate' },
  'developer.validation.empty': { en: 'No validation rules.', ro: 'Nicio regulă de validare.' },
  'developer.validation.modal.title': { en: 'New validation rule', ro: 'Regulă de validare nouă' },
  'developer.validation.fieldType': { en: 'Field type', ro: 'Tip câmp' },
  'developer.validation.ruleType': { en: 'Rule type', ro: 'Tip regulă' },
  'developer.validation.severity': { en: 'Severity', ro: 'Severitate' },
  'developer.validation.severity.error': { en: 'error (block)', ro: 'eroare (blochează)' },
  'developer.validation.severity.warning': { en: 'warning (allow)', ro: 'avertisment (permite)' },
  'developer.validation.aiAssisted': { en: 'AI-assisted', ro: 'Asistat de AI' },
  'developer.validation.aiPlaceholder': {
    en: "e.g. 'Romanian CNP - 13 digits'",
    ro: "ex. 'CNP românesc - 13 cifre'",
  },
  'developer.validation.aiRequires': {
    en: 'Requires the AI extension to be active.',
    ro: 'Necesită extensia AI activă.',
  },
  'developer.validation.configJson': { en: 'Config (JSON)', ro: 'Config (JSON)' },
  'developer.validation.toast.created': { en: 'Rule created.', ro: 'Regulă creată.' },
  'developer.validation.error.invalidJson': {
    en: 'Invalid JSON in config',
    ro: 'JSON invalid în config',
  },
  'developer.validation.error.aiFailed': { en: 'AI generation failed', ro: 'Generarea AI a eșuat' },
  'developer.validation.type.text': { en: 'text', ro: 'text' },
  'developer.validation.type.integer': { en: 'integer', ro: 'integer' },
  'developer.validation.type.number': { en: 'number', ro: 'number' },
  'developer.validation.type.email': { en: 'email', ro: 'email' },
  'developer.validation.type.date': { en: 'date', ro: 'date' },
  'developer.validation.type.uuid': { en: 'uuid', ro: 'uuid' },
  'developer.validation.type.boolean': { en: 'boolean', ro: 'boolean' },
  'developer.validation.rule.required': { en: 'required', ro: 'obligatoriu' },
  'developer.validation.rule.min': { en: 'min', ro: 'min' },
  'developer.validation.rule.max': { en: 'max', ro: 'max' },
  'developer.validation.rule.pattern': { en: 'pattern (regex)', ro: 'pattern (regex)' },
  'developer.validation.rule.enum': { en: 'enum', ro: 'enum' },
  'developer.validation.rule.custom': { en: 'custom', ro: 'custom' },
  'forms.empty': {
    en: 'No forms yet. Use the Forms API to create embeddable forms.',
    ro: 'Nicio formular încă. Folosește API Forms pentru formulare embed.',
  },
  'forms.col.fields': { en: 'Fields', ro: 'Câmpuri' },
  'forms.col.submissions': { en: 'Submissions', ro: 'Trimiteri' },
  'storage.cloud.root': { en: 'Root', ro: 'Rădăcină' },
  'storage.cloud.col.size': { en: 'Size', ro: 'Dimensiune' },
  'storage.cloud.col.modified': { en: 'Modified', ro: 'Modificat' },
  'storage.cloud.share': { en: 'Share', ro: 'Partajează' },
  'storage.cloud.generateLink': { en: 'Generate link', ro: 'Generează link' },
  'storage.cloud.copyClose': { en: 'Copy & close', ro: 'Copiază și închide' },
  'search.noResults': { en: 'No results found.', ro: 'Niciun rezultat.' },
  'search.configureIndex': { en: 'Configure index', ro: 'Configurează index' },
  'search.col.indexName': { en: 'Index name', ro: 'Nume index' },
  'search.col.records': { en: 'Records', ro: 'Înregistrări' },
  'search.col.lastSynced': { en: 'Last synced', ro: 'Ultima sincronizare' },
  'crm.transactions.title': { en: 'Transactions', ro: 'Tranzacții' },
  'crm.organizations.title': { en: 'Organizations', ro: 'Organizații' },
  'crm.col.taxId': { en: 'Tax ID', ro: 'CUI' },
  'operations.traceability.dispatches.directSuccess': {
    en: 'Dispatch recorded for',
    ro: 'Expediere înregistrată pentru',
  },
  'operations.traceability.dispatches.another': { en: '+ Another', ro: '+ Alta' },
  'ai.search.collection': { en: 'Collection', ro: 'Colecție' },
  'ai.search.placeholder': { en: 'e.g. articles', ro: 'ex. articole' },
  'ai.search.queryPlaceholder': {
    en: 'e.g. articles about machine learning',
    ro: 'ex. articole despre machine learning',
  },
  'ai.query.placeholder': {
    en: 'e.g. show me the 10 most recent users',
    ro: 'ex. ultimii 10 utilizatori înregistrați',
  },
  'ai.schema.placeholder': {
    en: 'e.g. a blog with posts, title, content, status',
    ro: 'ex. blog cu postări, titlu, conținut, status',
  },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

function dedupe(rel: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  const c = readFileSync(p, 'utf8');
  const marker = '\n{#if loading}';
  const first = c.indexOf(marker);
  const second = c.indexOf(marker, first + marker.length);
  if (second < 0) return;
  writeFileSync(p, c.slice(0, second).trimEnd() + '\n');
  console.log('deduped', rel);
}

function patch(rel: string, reps: [string, string][]) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of reps) c = c.replaceAll(a, b);
  if (c !== o) writeFileSync(p, c);
}

function fixCorruptOptions(c: string): string {
  // value="{m['x.{m['y']()}']()}" -> broken; fix option value="text" patterns
  return c.replace(
    /value="\{m\['[^"]+\{m\[[^\]]+\][^"]*"\]\(\)\}[^"]*">([^<]+)<\/option>/g,
    (_, label) => {
      const v = label.trim().toLowerCase().replace(/\s+/g, '_');
      return `<option value="${v}">${label}</option>`;
    },
  );
}

function ensureImport(path: string) {
  let c = readFileSync(path, 'utf8');
  if (!c.includes("from '$lib/i18n") && c.includes("m['")) {
    c = c.replace(
      /<script lang="ts">\n/,
      '<script lang="ts">\n  import { m } from \'$lib/i18n.svelte.js\';\n',
    );
    writeFileSync(path, c);
  }
}

// Dedupe corrupted pages
for (const rel of [
  'operations/pos/studio/pages/+page.svelte',
  'forms/studio/pages/+page.svelte',
  'compliance/ro/etransport/studio/pages/+page.svelte',
  'projects/management/studio/pages/+page.svelte',
])
  dedupe(rel);

patch('operations/pos/studio/pages/+page.svelte', [
  ['Session open', "{m['operations.pos.session.open']()}"],
  ['Opening float:', "{m['operations.pos.session.openingFloat']()}"],
  ['No open session.', "{m['operations.pos.session.noOpen']()}"],
  [' Close session', " {m['operations.pos.closeSession']()}"],
  [' Open session', " {m['operations.pos.openSession']()}"],
  [
    '<Receipt size={14} /> Recent orders',
    "<Receipt size={14} /> {m['operations.pos.recentOrders']()}",
  ],
  ['<th>Time</th>', "<th>{m['operations.pos.col.time']()}</th>"],
  ['Recent Z-reports', "{m['operations.pos.zReports']()}"],
  [
    '<th class="text-right">Sales</th>',
    '<th class="text-right">{m[\'operations.pos.col.sales\']()}</th>',
  ],
  [
    '<th class="text-right">Orders</th>',
    '<th class="text-right">{m[\'operations.pos.col.orderCount\']()}</th>',
  ],
]);

patch('forms/studio/pages/+page.svelte', [
  ['No forms yet. Use the Forms API to create embeddable forms.', "{m['forms.empty']()}"],
  ['<th>Fields</th>', "<th>{m['forms.col.fields']()}</th>"],
  ['<th>Submissions</th>', "<th>{m['forms.col.submissions']()}</th>"],
]);

patch('storage/cloud/studio/pages/+page.svelte', [
  ['>Root</button>', ">{m['storage.cloud.root']()}</button>"],
  [
    '<th class="text-right">Size</th>',
    '<th class="text-right">{m[\'storage.cloud.col.size\']()}</th>',
  ],
  ['<th>Modified</th>', "<th>{m['storage.cloud.col.modified']()}</th>"],
  ['title="Share"', "title={m['storage.cloud.share']()}"],
  ["title=m['common.delete']()", "title={m['common.delete']()}"],
  [' Generate link', " {m['storage.cloud.generateLink']()}"],
  ['Copy & close', "{m['storage.cloud.copyClose']()}"],
]);

patch('search/studio/pages/+page.svelte', [
  ['No results found.', "{m['search.noResults']()}"],
  [' Configure Index', " {m['search.configureIndex']()}"],
  ['<th>Index Name</th>', "<th>{m['search.col.indexName']()}</th>"],
  ['<th>Records</th>', "<th>{m['search.col.records']()}</th>"],
  ['<th>Last Synced</th>', "<th>{m['search.col.lastSynced']()}</th>"],
]);

patch('crm/studio/pages/transactions/+page.svelte', [
  [
    '<h1 class="text-2xl font-bold">Transactions</h1>',
    '<h1 class="text-2xl font-bold">{m[\'crm.transactions.title\']()}</h1>',
  ],
  ['<th>Number</th>', "<th>{m['common.col.number']()}</th>"],
  ['>Prev</button>', ">{m['common.prev']()}</button>"],
  ['>Next</button>', ">{m['common.next']()}</button>"],
]);

patch('crm/studio/pages/organizations/+page.svelte', [
  [
    '<h1 class="text-2xl font-bold">Organizations</h1>',
    '<h1 class="text-2xl font-bold">{m[\'crm.organizations.title\']()}</h1>',
  ],
  ['<th>Tax ID</th>', "<th>{m['crm.col.taxId']()}</th>"],
  ['<th>Industry</th>', "<th>{m['crm.col.industry']()}</th>"],
  ['>Prev</button>', ">{m['common.prev']()}</button>"],
  ['>Next</button>', ">{m['common.next']()}</button>"],
]);

patch('operations/traceability/studio/pages/dispatches/+page.svelte', [
  [
    'Expediere înregistrată cu succes pentru',
    "{m['operations.traceability.dispatches.directSuccess']()}",
  ],
  [
    "onclick={() => {m['operations.traceability.ui.directdone_null_alta']()}",
    "onclick={() => directDone = null}>{m['operations.traceability.dispatches.another']()}",
  ],
  [
    "onclick={assignLot}>{m['operations.traceability.ui.asigneaz']()}",
    "onclick={assignLot}>{m['common.assign']()}",
  ],
]);

en['common.assign'] = 'Assign';
ro['common.assign'] = 'Asignează';

// AI key aliases (replace ugly keys in ai page)
patch('ai/studio/pages/+page.svelte', [
  ["m['ai.ui.colec_ie']", "m['ai.search.collection']"],
  ["m['ai.ui.ex_articles']", "m['ai.search.placeholder']"],
  ["m['ai.ui.ex_articole_despre_machine_learning']", "m['ai.search.queryPlaceholder']"],
  ["m['ai.ui.ex_show_me_the_10_most_recent_users_who_signed_u']", "m['ai.query.placeholder']"],
  ["m['ai.ui.ex_a_blog_with_posts_title_content_status_author']", "m['ai.schema.placeholder']"],
]);

// Fix validation file from backup + i18n (skip if already migrated)
const valPath = join(EXT, 'developer/validation/studio/pages/+page.svelte');
const valBackup = join(EXT, 'developer/validation/studio/pages/_git_backup.svelte');
if (!existsSync(valBackup)) {
  console.log('validation: skip (no backup)');
} else {
  let val = readFileSync(valBackup, 'utf8');
  val = val.replace(/ÔÇö/g, '—');
  val =
    `<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ShieldCheck, Plus, X, Sparkles, LoaderCircle } from '@lucide/svelte';

` + val.slice(val.indexOf('let rules'));

  const valPatches: [RegExp | string, string][] = [
    [
      "toast.error(e?.message ?? 'Failed to load')",
      "toast.error(e?.message ?? m['ext.loadFailed']())",
    ],
    [
      "throw new Error('Invalid JSON in config')",
      "throw new Error(m['developer.validation.error.invalidJson']())",
    ],
    ["toast.success('Rule created.')", "toast.success(m['developer.validation.toast.created']())"],
    ["toast.error(e?.message ?? 'Error')", "toast.error(e?.message ?? m['ext.saveFailed']())"],
    [
      "toast.error(e?.message ?? 'AI generation failed')",
      "toast.error(e?.message ?? m['developer.validation.error.aiFailed']())",
    ],
    ["if (!confirm('Delete rule?'))", "if (!confirm(m['developer.validation.confirmDelete']())"],
    ['Data Validation Rules', "{m['developer.validation.title']()}"],
    ['Field-level validation with AI assistance', "{m['developer.validation.subtitle']()}"],
    [' New rule', " {m['developer.validation.newRule']()}"],
    ['All collections', "{m['developer.validation.allCollections']()}"],
    ['<th>Collection</th>', "<th>{m['common.col.collection']()}</th>"],
    ['<th>Field</th>', "<th>{m['common.col.field']()}</th>"],
    ['<th>Rule type</th>', "<th>{m['developer.validation.col.ruleType']()}</th>"],
    ['<th>Description</th>', "<th>{m['common.col.description']()}</th>"],
    ['<th>Severity</th>', "<th>{m['developer.validation.col.severity']()}</th>"],
    ['No validation rules.', "{m['developer.validation.empty']()}"],
    ['>Delete</button>', ">{m['common.delete']()}</button>"],
    ['New validation rule', "{m['developer.validation.modal.title']()}"],
    ['Collection *', "{m['common.col.collection']()} *"],
    ['Field *', "{m['common.col.field']()} *"],
    ['Field type', "{m['developer.validation.fieldType']()}"],
    ['Rule type', "{m['developer.validation.ruleType']()}"],
    ['Severity', "{m['developer.validation.severity']()}"],
    ['AI-assisted', "{m['developer.validation.aiAssisted']()}"],
    [
      'placeholder="e.g. \'Romanian CNP - 13 digits\'"',
      "placeholder={m['developer.validation.aiPlaceholder']()}",
    ],
    [' Generate', " {m['common.generate']()}"],
    ['Requires the AI extension to be active.', "{m['developer.validation.aiRequires']()}"],
    ['Config (JSON)', "{m['developer.validation.configJson']()}"],
    ['Cancel', "{m['common.cancel']()}"],
    ['Create rule', "{m['developer.validation.newRule']()}"],
  ];
  for (const [a, b] of valPatches) {
    if (typeof a === 'string') val = val.replaceAll(a, b);
    else val = val.replace(a, b);
  }
  // option values stay as API values; labels can stay English for field types
  writeFileSync(valPath, fixCorruptOptions(val));
  try {
    unlinkSync(valBackup);
  } catch {}
}

// Global fix corrupt options in all svelte files
function walkSvelte(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSvelte(p, out);
    else if (e.name.endsWith('.svelte')) out.push(p);
  }
  return out;
}
let fixedOpts = 0;
for (const p of walkSvelte(EXT)) {
  let c = readFileSync(p, 'utf8');
  if (!c.includes("{m['") || !c.includes('{m[')) continue;
  const n = fixCorruptOptions(c);
  if (n !== c) {
    writeFileSync(p, n);
    fixedOpts++;
  }
}

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log(`i18n-batch-commerce done, fixed ${fixedOpts} option corruptions`);
