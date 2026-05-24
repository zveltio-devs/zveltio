#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '../../../zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

const KEYS: Record<string, { en: string; ro: string }> = {
  'compliance.ro.saft.btn.newExport': { en: 'New Export', ro: 'Export nou' },
  'compliance.ro.saft.btn.addAccount': { en: 'Add Account', ro: 'Adaugă cont' },
  'compliance.ro.saft.btn.addEntry': { en: 'Add Entry', ro: 'Adaugă înregistrare' },
  'compliance.ro.saft.tab.exports': { en: 'Exports', ro: 'Exporturi' },
  'compliance.ro.saft.tab.accounts': { en: 'Accounts', ro: 'Conturi' },
  'compliance.ro.saft.tab.entries': { en: 'Journal Entries', ro: 'Înregistrări jurnal' },
  'compliance.ro.saft.emptyExports': { en: 'No SAF-T exports yet.', ro: 'Niciun export SAF-T încă.' },
  'compliance.ro.saft.col.period': { en: 'Period', ro: 'Perioadă' },
  'compliance.ro.saft.col.company': { en: 'Company', ro: 'Companie' },
  'compliance.ro.saft.col.cui': { en: 'CUI', ro: 'CUI' },
  'compliance.ro.saft.col.document': { en: 'Document', ro: 'Document' },
  'compliance.ro.saft.btn.generateXml': { en: 'XML', ro: 'XML' },
  'compliance.ro.saft.btn.createExport': { en: 'Create Export', ro: 'Creează export' },
  'compliance.ro.saft.toast.submissionFailed': { en: 'Submission failed', ro: 'Trimiterea a eșuat' },
  'compliance.ro.saft.accountType.balance': { en: 'Balance', ro: 'Bilanț' },
  'ecommerce.store.btn.newProduct': { en: 'New Product', ro: 'Produs nou' },
  'ecommerce.store.stat.revenue': { en: 'Revenue', ro: 'Venituri' },
  'ecommerce.store.stat.products': { en: 'Products', ro: 'Produse' },
  'ecommerce.store.stat.orders': { en: 'Orders', ro: 'Comenzi' },
  'ecommerce.store.tab.products': { en: 'Products', ro: 'Produse' },
  'ecommerce.store.tab.orders': { en: 'Orders', ro: 'Comenzi' },
  'ecommerce.store.empty.products': { en: 'No products yet', ro: 'Niciun produs încă' },
  'ecommerce.store.empty.orders': { en: 'No orders yet', ro: 'Nicio comandă încă' },
  'ecommerce.store.col.stock': { en: 'Stock', ro: 'Stoc' },
  'ecommerce.store.col.orderNumber': { en: 'Order #', ro: 'Comandă #' },
  'ecommerce.store.col.customer': { en: 'Customer', ro: 'Client' },
  'ecommerce.store.status.inactive': { en: 'Inactive', ro: 'Inactiv' },
  'ecommerce.store.btn.create': { en: 'Create', ro: 'Creează' },
  'content.media.section.storage': { en: 'Storage', ro: 'Stocare' },
  'content.media.empty.files': { en: 'No files found', ro: 'Niciun fișier' },
  'content.media.empty.filesHint': { en: 'Upload files or change filters', ro: 'Încarcă fișiere sau schimbă filtrele' },
  'content.media.detail.size': { en: 'Size', ro: 'Dimensiune' },
  'content.media.detail.dimensions': { en: 'Dimensions', ro: 'Dimensiuni' },
  'content.media.detail.uploaded': { en: 'Uploaded', ro: 'Încărcat' },
  'content.media.detail.tags': { en: 'Tags', ro: 'Etichete' },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

// Remove corrupted duplicate block (second {#if loading})
function dedupeAtSecondLoading(rel: string) {
  const p = join(EXT, rel);
  if (!existsSync(p)) return;
  const c = readFileSync(p, 'utf8');
  const re = /\{#if loading\}/g;
  const first = re.exec(c);
  if (!first) return;
  const second = re.exec(c);
  if (!second) return;
  const cutAt = second.index;
  writeFileSync(p, c.slice(0, cutAt).trimEnd() + '\n');
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

dedupeAtSecondLoading('compliance/ro/saft/studio/pages/+page.svelte');
dedupeAtSecondLoading('ecommerce/store/studio/pages/+page.svelte');

patch('compliance/ro/saft/studio/pages/+page.svelte', [
  ['<Plus size={14} /> New Export</button>', '<Plus size={14} /> {m[\'compliance.ro.saft.btn.newExport\']()}</button>'],
  ['<Plus size={14} /> Add Account</button>', '<Plus size={14} /> {m[\'compliance.ro.saft.btn.addAccount\']()}</button>'],
  ['<Plus size={14} /> Add Entry</button>', '<Plus size={14} /> {m[\'compliance.ro.saft.btn.addEntry\']()}</button>'],
  ["[['exports', 'Exports'], ['accounts', 'Accounts'], ['entries', 'Journal Entries']]", "[['exports', m['compliance.ro.saft.tab.exports']()], ['accounts', m['compliance.ro.saft.tab.accounts']()], ['entries', m['compliance.ro.saft.tab.entries']()]]"],
  ['No SAF-T exports yet.', "{m['compliance.ro.saft.emptyExports']()}"],
  ['<th>Period</th>', '<th>{m[\'compliance.ro.saft.col.period\']()}</th>'],
  ['<th>Company</th>', '<th>{m[\'compliance.ro.saft.col.company\']()}</th>'],
  ['<th>CUI</th>', '<th>{m[\'compliance.ro.saft.col.cui\']()}</th>'],
  ['<th>Document</th>', '<th>{m[\'compliance.ro.saft.col.document\']()}</th>'],
  [
    `onclick={() => {m['compliance.ro.saft.ui.generatexml_exp_id_xml']()}</button>`,
    `onclick={() => generateXML(exp.id)}>{m['compliance.ro.saft.btn.generateXml']()}</button>`,
  ],
  [' Create Export', " {m['compliance.ro.saft.btn.createExport']()}"],
  ['<span class="label-text text-xs">Description</span>', '<span class="label-text text-xs">{m[\'common.col.description\']()}</span>'],
  ['<span class="label-text text-xs">Type</span>', '<span class="label-text text-xs">{m[\'common.col.type\']()}</span>'],
  ['<span class="label-text text-xs">Date</span>', '<span class="label-text text-xs">{m[\'common.col.date\']()}</span>'],
  ["toast.error(e?.message ?? 'Submission failed')", "toast.error(e?.message ?? m['compliance.ro.saft.toast.submissionFailed']())"],
]);

patch('ecommerce/store/studio/pages/+page.svelte', [
  [
    `<div class="flex justify-end"><button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
        <Plus size={14} /> New Product
      </button></div>

<div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Revenue</div>
        <div class="stat-value text-lg">{stats.total_revenue.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Products</div>
        <div class="stat-value text-lg">{stats.total_products}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">{m['common.status.pending']()}</div>
        <div class="stat-value text-lg text-warning">{stats.pending_orders}</div>
      </div>
    </div>
  {/if}`,
    `<div class="flex justify-end"><button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
        <Plus size={14} /> {m['ecommerce.store.btn.newProduct']()}
      </button></div>

  {#if stats}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">{m['ecommerce.store.stat.orders']()}</div>
        <div class="stat-value text-lg">{stats.total_orders}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">{m['ecommerce.store.stat.revenue']()}</div>
        <div class="stat-value text-lg">{stats.total_revenue.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">{m['ecommerce.store.stat.products']()}</div>
        <div class="stat-value text-lg">{stats.total_products}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">{m['common.status.pending']()}</div>
        <div class="stat-value text-lg text-warning">{stats.pending_orders}</div>
      </div>
    </div>
  {/if}`,
  ],
  ['<Tag size={13} class="mr-1.5" /> Products', '<Tag size={13} class="mr-1.5" /> {m[\'ecommerce.store.tab.products\']()}'],
  ['<ShoppingCart size={13} class="mr-1.5" /> Orders', '<ShoppingCart size={13} class="mr-1.5" /> {m[\'ecommerce.store.tab.orders\']()}'],
  ['No products yet', "{m['ecommerce.store.empty.products']()}"],
  ['No orders yet', "{m['ecommerce.store.empty.orders']()}"],
  ['<th>Stock</th>', '<th>{m[\'ecommerce.store.col.stock\']()}</th>'],
  ["'Inactive'", "m['ecommerce.store.status.inactive']()"],
  ['<th>Order #</th>', '<th>{m[\'ecommerce.store.col.orderNumber\']()}</th>'],
  ['<th>Customer</th>', '<th>{m[\'ecommerce.store.col.customer\']()}</th>'],
  ['{/if}Create', '{/if}{m[\'ecommerce.store.btn.create\']()}'],
]);

patch('content/media/studio/pages/+page.svelte', [
  ['<h4 class="font-bold text-sm mb-2">Storage</h4>', '<h4 class="font-bold text-sm mb-2">{m[\'content.media.section.storage\']()}</h4>'],
  ['<p>No files found</p>', '<p>{m[\'content.media.empty.files\']()}</p>'],
  ['<p class="text-sm">Upload files or change filters</p>', '<p class="text-sm">{m[\'content.media.empty.filesHint\']()}</p>'],
  ['<div class="text-xs opacity-60">Size</div>', '<div class="text-xs opacity-60">{m[\'content.media.detail.size\']()}</div>'],
  ['<div class="text-xs opacity-60">Dimensions</div>', '<div class="text-xs opacity-60">{m[\'content.media.detail.dimensions\']()}</div>'],
  ['<div class="text-xs opacity-60">Uploaded</div>', '<div class="text-xs opacity-60">{m[\'content.media.detail.uploaded\']()}</div>'],
  ['<div class="text-xs opacity-60 mb-1">Tags</div>', '<div class="text-xs opacity-60 mb-1">{m[\'content.media.detail.tags\']()}</div>'],
]);

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('i18n-batch-compliance-media done');
