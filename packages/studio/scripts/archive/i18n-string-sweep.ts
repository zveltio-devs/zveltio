#!/usr/bin/env bun
/** Second pass: replace remaining common English UI strings with Paraglide keys. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT_ROOT = join(STUDIO, '../../../zveltio-extensions');
const EN_PATH = join(STUDIO, 'messages/en.json');
const RO_PATH = join(STUDIO, 'messages/ro.json');

const REPLACEMENTS: [string, string][] = [
  ['No quotes yet. Create your first quote.', "m['finance.quotes.empty']()"],
  ['No requests.', "m['hr.leave.emptyRequests']()"],
  ['New request', "m['hr.leave.new']()"],
  ['New Quote', "m['quotes.new']()"],
  ['New entry', "m['finance.accounting.newEntry']()"],
  ['New account', "m['finance.banking.newAccount']()"],
  ['Journal entries', "m['finance.accounting.tab.entries']()"],
  ['Chart of accounts', "m['finance.accounting.tab.accounts']()"],
  ['Fiscal years', "m['finance.accounting.tab.fiscal']()"],
  ['Entry posted.', "m['finance.accounting.toast.posted']()"],
  [
    "toast.success(approved ? 'Approved.' : 'Rejected.')",
    "toast.success(approved ? m['ext.approved']() : m['ext.rejected']())",
  ],
  ['Delete this quote?', "m['finance.quotes.deleteConfirm']()"],
  ['No expenses.', "m['finance.expenses.empty']()"],
  ['No imports yet.', "m['data.import.empty']()"],
  ['New import', "m['data.import.new']()"],
  ['Import data', "m['data.import.form.title']()"],
  ['Target collection', "m['data.import.form.collection']()"],
  ['Close', "m['common.close']()"],
  ['Import', "m['data.import.action.import']()"],
  ['Uploading…', "m['common.uploading']()"],
  ['No exports yet.', "m['data.export.empty']()"],
  ['Something went wrong', "m['ext.loadFailed']()"],
  ['>Submit<', ">{m['common.submit']()}<"],
];

const EXTRA_EN: Record<string, string> = {
  'finance.quotes.empty': 'No quotes yet. Create your first quote.',
  'finance.quotes.deleteConfirm': 'Delete this quote?',
  'hr.leave.emptyRequests': 'No leave requests yet.',
  'finance.accounting.tab.entries': 'Journal entries',
  'finance.accounting.tab.accounts': 'Chart of accounts',
  'finance.accounting.tab.fiscal': 'Fiscal years',
  'finance.accounting.toast.posted': 'Entry posted',
  'data.import.empty': 'No imports yet.',
  'data.import.new': 'New import',
  'data.import.form.title': 'Import data',
  'data.import.form.collection': 'Target collection',
  'data.import.action.import': 'Import',
  'data.export.empty': 'No exports yet.',
  'common.close': 'Close',
  'common.uploading': 'Uploading…',
};

const EXTRA_RO: Record<string, string> = {
  'finance.quotes.empty': 'Nicio ofertă. Creează prima ofertă.',
  'finance.quotes.deleteConfirm': 'Ștergi această ofertă?',
  'hr.leave.emptyRequests': 'Nicio cerere de concediu.',
  'finance.accounting.tab.entries': 'Înregistrări jurnal',
  'finance.accounting.tab.accounts': 'Plan de conturi',
  'finance.accounting.tab.fiscal': 'Ani fiscali',
  'finance.accounting.toast.posted': 'Înregistrare postată',
  'data.import.empty': 'Nicio importare încă.',
  'data.import.new': 'Import nou',
  'data.import.form.title': 'Import date',
  'data.import.form.collection': 'Colecție țintă',
  'data.import.action.import': 'Importă',
  'data.export.empty': 'Nicio exportare încă.',
  'common.close': 'Închide',
  'common.uploading': 'Se încarcă…',
};

function walk(base: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (existsSync(join(base, e.name, 'manifest.json'))) out.push(rel);
    else out.push(...walk(join(base, e.name), rel));
  }
  return out;
}

const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));
const ro = JSON.parse(readFileSync(RO_PATH, 'utf8'));
Object.assign(en, EXTRA_EN);
for (const [k, v] of Object.entries(EXTRA_EN)) ro[k] = EXTRA_RO[k] ?? v;

let n = 0;
for (const ext of walk(EXT_ROOT)) {
  const p = join(EXT_ROOT, ext, 'studio', 'pages', '+page.svelte');
  if (!existsSync(p)) continue;
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [from, to] of REPLACEMENTS) {
    if (from.startsWith('toast.') || from.startsWith('>')) c = c.replaceAll(from, to);
    else if (c.includes(from) && !c.includes(to)) {
      c = c.replaceAll(`>${from}<`, `>{${to}}<`);
      c = c.replaceAll(`'${from}'`, to);
      c = c.replaceAll(`"${from}"`, to);
    }
  }
  if (c !== o) {
    writeFileSync(p, c);
    n++;
  }
}
writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO_PATH, JSON.stringify(ro, null, 2) + '\n');
console.log(`[i18n-sweep] ${n} pages updated`);
