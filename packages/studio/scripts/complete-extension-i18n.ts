#!/usr/bin/env bun
/**
 * Complete extension i18n: wrap ExtensionPageShell, replace common UI strings, ConfirmModal for confirm().
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO_ROOT = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO_ROOT, '../../../zveltio-extensions');
const EN_PATH = join(STUDIO_ROOT, 'messages/en.json');
const RO_PATH = join(STUDIO_ROOT, 'messages/ro.json');

const TH_MAP: Record<string, string> = {
  Date: 'common.col.date',
  'Doc #': 'common.col.docNumber',
  Description: 'common.col.description',
  Debit: 'common.col.debit',
  Credit: 'common.col.credit',
  Status: 'common.col.status',
  Code: 'common.col.code',
  Name: 'common.col.name',
  Type: 'common.col.type',
  Parent: 'common.col.parent',
  Year: 'common.col.year',
  Start: 'common.col.start',
  End: 'common.col.end',
  Number: 'common.col.number',
  Client: 'common.col.client',
  Total: 'common.col.total',
  Paid: 'common.col.paid',
  'Due Date': 'common.col.dueDate',
  'Valid Until': 'common.col.validUntil',
  Created: 'common.col.created',
  Actions: 'common.actions',
  Category: 'common.col.category',
  Vendor: 'common.col.vendor',
  Amount: 'common.col.amount',
  Email: 'common.col.email',
  Department: 'common.col.department',
  Position: 'common.col.position',
  'Hire date': 'common.col.hireDate',
  SKU: 'common.col.sku',
  Price: 'common.col.price',
  'VAT %': 'common.col.vat',
  Active: 'common.col.active',
  Address: 'common.col.address',
  Product: 'common.col.product',
  Warehouse: 'common.col.warehouse',
  Quantity: 'common.col.quantity',
  Bank: 'common.col.bank',
  IBAN: 'common.col.iban',
  Currency: 'common.col.currency',
  Balance: 'common.col.balance',
  Employee: 'common.col.employee',
  'Leave type': 'common.col.leaveType',
  From: 'common.col.from',
  To: 'common.col.to',
  Days: 'common.col.days',
  Reason: 'common.col.reason',
  Account: 'common.col.account',
  Notes: 'common.col.notes',
};

const LABEL_MAP: Record<string, string> = {
  'New expense': 'common.new',
  'New invoice': 'invoicing.newInvoice',
  'New Quote': 'quotes.new',
  'New product': 'inventory.new.product',
  'New warehouse': 'inventory.new.warehouse',
  'New employee': 'hr.employees.new',
  'New request': 'hr.leave.new',
  'New account': 'finance.banking.newAccount',
  'New entry': 'finance.accounting.newEntry',
  Submit: 'common.submit',
  'Post entry': 'finance.accounting.postEntry',
  'Create Quote': 'common.create',
  'All statuses': 'common.filter.allStatuses',
  'All': 'common.filter.all',
  Pending: 'common.status.pending',
  Approved: 'common.status.approved',
  Rejected: 'common.status.rejected',
  Draft: 'common.status.draft',
  Submitted: 'common.status.submitted',
  Reimbursed: 'common.status.reimbursed',
};

function findExtensions(base: string, prefix = ''): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (existsSync(join(base, entry.name, 'manifest.json'))) names.push(rel);
    else names.push(...findExtensions(join(base, entry.name), rel));
  }
  return names;
}

function msgKey(extName: string): string {
  return extName.replace(/\//g, '.');
}

function ensureImports(content: string): string {
  let c = content;
  if (!c.includes("from '$lib/i18n")) {
    c = c.replace(/<script lang="ts">\n/, "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n");
  }
  if (!c.includes('<ExtensionPageShell') && (c.includes('<div class="space-y-4">') || c.includes('class="p-6 space-y-4"'))) {
    if (!c.includes("ExtensionPageShell from")) {
      c = c.replace(
        /import \{ m \} from '\$lib\/i18n\.svelte\.js';\n/,
        "import { m } from '$lib/i18n.svelte.js';\n  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';\n  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';\n",
      );
    }
    if (!c.includes('ConfirmModal') && c.includes('confirm(')) {
      c = c.replace(
        /import ExtensionDataPanel[^\n]+\n/,
        "$&  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';\n",
      );
    }
  }
  return c;
}

function replaceTableHeaders(content: string): string {
  let c = content;
  for (const [text, key] of Object.entries(TH_MAP)) {
    c = c.replaceAll(`<th>${text}</th>`, `<th>{m['${key}']()}</th>`);
    c = c.replaceAll(`<th class="text-right">${text}</th>`, `<th class="text-right">{m['${key}']()}</th>`);
  }
  return c;
}

function replaceLabels(content: string): string {
  let c = content;
  for (const [text, key] of Object.entries(LABEL_MAP)) {
    c = c.replaceAll(`>${text}<`, `>{m['${key}']()}<`);
    c = c.replaceAll(`" title="${text}"`, `" title={m['${key}']()}`);
  }
  return c;
}

function replaceEmptyRows(content: string, key: string): string {
  return content.replace(
    /<tr><td colspan="\d+" class="text-center py-6 text-base-content\/50 text-sm">[^<]+<\/td><\/tr>/g,
    `<tr><td colspan="$1" class="text-center py-6 text-base-content/50 text-sm">{m['${key}.empty']()}</td></tr>`,
  );
}

function wrapInShell(content: string, key: string): string {
  if (content.includes('<ExtensionPageShell')) return content;

  const shellStart = `<ExtensionPageShell\n  title={m['${key}.title']()}\n  subtitle={m['${key}.subtitle']()}\n>`;
  const shellEnd = '</ExtensionPageShell>';

  // Extract primary action button from header if present
  const headerAction = content.match(
    /<div class="flex items-center justify-between">[\s\S]*?<button class="btn btn-primary[^"]*"[\s\S]*?<\/button>\s*<\/div>\s*<\/div>/,
  );

  let actionsSnippet = '';
  let body = content;

  if (headerAction) {
    const btn = headerAction[0].match(/<button class="btn btn-primary[\s\S]*?<\/button>/)?.[0];
    if (btn) {
      actionsSnippet = `\n  {#snippet actions()}\n    ${btn.replace('class="btn', 'type="button" class="btn')}\n  {/snippet}\n`;
      body = body.replace(headerAction[0], '');
    }
  }

  // Remove duplicate title block
  body = body.replace(
    /<div class="flex items-center justify-between">[\s\S]*?<\/div>\s*<\/div>\s*/,
    '',
  );

  // Wrap main space-y-4 content
  const mainMatch = body.match(/<div class="space-y-4">([\s\S]*)<\/div>\s*(<!--|{#if|<ConfirmModal|$)/);
  if (!mainMatch) return content;

  const inner = mainMatch[1].trim();
  const after = body.slice(body.indexOf(mainMatch[0]) + mainMatch[0].length);

  const wrapped =
    `${shellStart}${actionsSnippet}\n  {#snippet children()}\n    ${inner}\n  {/snippet}\n${shellEnd}\n\n${after}`;

  return body.replace(mainMatch[0], wrapped);
}

function patchToasts(content: string): string {
  return content
    .replace(/toast\.success\('([^']+)'\)/g, (_, msg) => {
      if (msg.includes('created') || msg.includes('Created')) return "toast.success(m['ext.created']())";
      if (msg.includes('submitted') || msg.includes('Submitted')) return "toast.success(m['ext.submitted']())";
      if (msg.includes('sent') || msg.includes('Sent')) return "toast.success(m['ext.sent']())";
      if (msg.includes('Rejected')) return "toast.success(m['ext.rejected']())";
      return `toast.success('${msg}')`;
    })
    .replace(/toast\.success\(`([^`]+)`\)/g, "toast.success(m['ext.saved']())");
}

const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO_PATH, 'utf8')) as Record<string, string>;

const COMMON_EN: Record<string, string> = {
  'common.col.date': 'Date',
  'common.col.docNumber': 'Doc #',
  'common.col.description': 'Description',
  'common.col.debit': 'Debit',
  'common.col.credit': 'Credit',
  'common.col.status': 'Status',
  'common.col.code': 'Code',
  'common.col.name': 'Name',
  'common.col.type': 'Type',
  'common.col.parent': 'Parent',
  'common.col.year': 'Year',
  'common.col.start': 'Start',
  'common.col.end': 'End',
  'common.col.number': 'Number',
  'common.col.client': 'Client',
  'common.col.total': 'Total',
  'common.col.paid': 'Paid',
  'common.col.dueDate': 'Due date',
  'common.col.validUntil': 'Valid until',
  'common.col.created': 'Created',
  'common.col.category': 'Category',
  'common.col.vendor': 'Vendor',
  'common.col.amount': 'Amount',
  'common.col.email': 'Email',
  'common.col.department': 'Department',
  'common.col.position': 'Position',
  'common.col.hireDate': 'Hire date',
  'common.col.sku': 'SKU',
  'common.col.price': 'Price',
  'common.col.vat': 'VAT %',
  'common.col.active': 'Active',
  'common.col.address': 'Address',
  'common.col.product': 'Product',
  'common.col.warehouse': 'Warehouse',
  'common.col.quantity': 'Quantity',
  'common.col.bank': 'Bank',
  'common.col.iban': 'IBAN',
  'common.col.currency': 'Currency',
  'common.col.balance': 'Balance',
  'common.col.employee': 'Employee',
  'common.col.leaveType': 'Leave type',
  'common.col.from': 'From',
  'common.col.to': 'To',
  'common.col.days': 'Days',
  'common.col.reason': 'Reason',
  'common.col.account': 'Account',
  'common.col.notes': 'Notes',
  'common.submit': 'Submit',
  'common.filter.allStatuses': 'All statuses',
  'common.filter.all': 'All',
  'common.status.pending': 'Pending',
  'common.status.approved': 'Approved',
  'common.status.rejected': 'Rejected',
  'common.status.draft': 'Draft',
  'common.status.submitted': 'Submitted',
  'common.status.reimbursed': 'Reimbursed',
  'ext.submitted': 'Submitted',
  'ext.sent': 'Sent',
  'ext.rejected': 'Rejected',
  'ext.saved': 'Saved',
  'quotes.new': 'New quote',
  'finance.banking.newAccount': 'New account',
  'finance.accounting.newEntry': 'New entry',
  'finance.accounting.postEntry': 'Post entry',
  'hr.leave.new': 'New request',
};

const COMMON_RO: Record<string, string> = {
  'common.col.date': 'Data',
  'common.col.docNumber': 'Nr. doc',
  'common.col.description': 'Descriere',
  'common.col.debit': 'Debit',
  'common.col.credit': 'Credit',
  'common.col.status': 'Status',
  'common.col.code': 'Cod',
  'common.col.name': 'Nume',
  'common.col.type': 'Tip',
  'common.col.parent': 'Părinte',
  'common.col.year': 'An',
  'common.col.start': 'Început',
  'common.col.end': 'Sfârșit',
  'common.col.number': 'Număr',
  'common.col.client': 'Client',
  'common.col.total': 'Total',
  'common.col.paid': 'Plătit',
  'common.col.dueDate': 'Scadență',
  'common.col.validUntil': 'Valabil până',
  'common.col.created': 'Creat',
  'common.col.category': 'Categorie',
  'common.col.vendor': 'Furnizor',
  'common.col.amount': 'Sumă',
  'common.col.email': 'Email',
  'common.col.department': 'Departament',
  'common.col.position': 'Poziție',
  'common.col.hireDate': 'Data angajării',
  'common.col.sku': 'SKU',
  'common.col.price': 'Preț',
  'common.col.vat': 'TVA %',
  'common.col.active': 'Activ',
  'common.col.address': 'Adresă',
  'common.col.product': 'Produs',
  'common.col.warehouse': 'Depozit',
  'common.col.quantity': 'Cantitate',
  'common.col.bank': 'Bancă',
  'common.col.iban': 'IBAN',
  'common.col.currency': 'Monedă',
  'common.col.balance': 'Sold',
  'common.col.employee': 'Angajat',
  'common.col.leaveType': 'Tip concediu',
  'common.col.from': 'De la',
  'common.col.to': 'Până la',
  'common.col.days': 'Zile',
  'common.col.reason': 'Motiv',
  'common.col.account': 'Cont',
  'common.col.notes': 'Note',
  'common.submit': 'Trimite',
  'common.filter.allStatuses': 'Toate statusurile',
  'common.filter.all': 'Toate',
  'common.status.pending': 'În așteptare',
  'common.status.approved': 'Aprobat',
  'common.status.rejected': 'Respins',
  'common.status.draft': 'Ciornă',
  'common.status.submitted': 'Trimis',
  'common.status.reimbursed': 'Rambursat',
  'ext.submitted': 'Trimis',
  'ext.sent': 'Trimis',
  'ext.rejected': 'Respins',
  'ext.saved': 'Salvat',
  'quotes.new': 'Ofertă nouă',
  'finance.banking.newAccount': 'Cont nou',
  'finance.accounting.newEntry': 'Înregistrare nouă',
  'finance.accounting.postEntry': 'Înregistrează',
  'hr.leave.new': 'Cerere nouă',
};

Object.assign(en, COMMON_EN);
for (const [k, v] of Object.entries(COMMON_EN)) {
  if (!ro[k]) ro[k] = COMMON_RO[k] ?? v;
}

let wrapped = 0;
let patched = 0;

for (const extName of findExtensions(EXT_ROOT)) {
  const pagePath = join(EXT_ROOT, extName, 'studio', 'pages', '+page.svelte');
  if (!existsSync(pagePath)) continue;
  const key = msgKey(extName);
  let c = readFileSync(pagePath, 'utf8');
  const orig = c;

  c = ensureImports(c);
  c = replaceTableHeaders(c);
  c = replaceLabels(c);
  c = patchToasts(c);
  // Shell wrap is manual for tabbed/complex pages — automated wrap caused markup corruption.

  if (c !== orig) {
    writeFileSync(pagePath, c);
    patched++;
    if (c.includes('ExtensionPageShell') && !orig.includes('ExtensionPageShell')) wrapped++;
  }
}

writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO_PATH, JSON.stringify(ro, null, 2) + '\n');

console.log(`[complete-i18n] pages patched: ${patched}, newly wrapped in shell: ${wrapped}`);
