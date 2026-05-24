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
  'hr.time-tracking.ui.newProjectBtn': { en: 'New project', ro: 'Proiect nou' },
  'hr.time-tracking.ui.stopTimer': { en: 'Stop timer', ro: 'Oprește cronometrul' },
  'hr.time-tracking.ui.startTimerBtn': { en: 'Start timer', ro: 'Pornește cronometrul' },
  'hr.time-tracking.tab.projects': { en: 'Projects', ro: 'Proiecte' },
  'hr.time-tracking.tab.entries': { en: 'Entries', ro: 'Înregistrări' },
  'hr.time-tracking.col.rate': { en: 'Rate', ro: 'Tarif' },
  'hr.time-tracking.col.hours': { en: 'Hours', ro: 'Ore' },
  'hr.time-tracking.col.billable': { en: 'Billable', ro: 'Facturabil' },
  'hr.time-tracking.badge.billable': { en: 'Billable', ro: 'Facturabil' },
  'hr.time-tracking.badge.internal': { en: 'Internal', ro: 'Intern' },
  'hr.time-tracking.empty.projects': { en: 'No projects yet', ro: 'Niciun proiect încă' },
  'hr.time-tracking.empty.entries': { en: 'No time entries yet', ro: 'Nicio înregistrare de timp' },
  'hr.time-tracking.timer.running': { en: 'Timer running on', ro: 'Cronometru activ pe' },
  'hr.time-tracking.timer.started': { en: 'started', ro: 'pornit la' },
  'hr.time-tracking.form.billableProject': { en: 'Billable project', ro: 'Proiect facturabil' },
  'hr.time-tracking.ui.description': { en: 'Description', ro: 'Descriere' },
  'finance.accounting.ui.lines': { en: 'Lines', ro: 'Linii' },
  'finance.accounting.ui.addLine': { en: 'Add line', ro: 'Adaugă linie' },
  'finance.accounting.ui.offBy': { en: 'Off by', ro: 'Diferență' },
  'finance.accounting.status.open': { en: 'open', ro: 'deschis' },
  'finance.accounting.status.closed': { en: 'closed', ro: 'închis' },
  'finance.accounting.ui.expense': { en: 'Expense', ro: 'Cheltuială' },
  'ext.confirm.deleteNamed': { en: 'Delete {name}?', ro: 'Ștergi {name}?' },
  'ext.confirm.deleteForm': { en: 'Delete form "{name}"? This will also delete all submissions.', ro: 'Ștergi formularul "{name}"? Se vor șterge și toate trimiterile.' },
  'ext.confirm.removeSearchIndex': { en: 'Remove search index for "{collection}"?', ro: 'Elimini indexul de căutare pentru "{collection}"?' },
  'common.prev': { en: 'Previous', ro: 'Înapoi' },
  'common.next': { en: 'Next', ro: 'Înainte' },
  'common.pageOf': { en: 'Page {page} of {total}', ro: 'Pagina {page} din {total}' },
  'crm.contacts.count': { en: '{count} contacts', ro: '{count} contacte' },
  'crm.ui.editContact': { en: 'Edit contact', ro: 'Editează contact' },
  'crm.ui.newContactTitle': { en: 'New contact', ro: 'Contact nou' },
  'communications.mail.ui.newFilterBtn': { en: 'New filter', ro: 'Filtru nou' },
  'communications.mail.draft.to': { en: 'To:', ro: 'Către:' },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
}

function patch(path: string, reps: [string, string][]) {
  const p = join(EXT, path);
  if (!existsSync(p)) return;
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of reps) c = c.replaceAll(a, b);
  if (c !== o) writeFileSync(p, c);
}

function dedupe(path: string, marker: string) {
  const p = join(EXT, path);
  let c = readFileSync(p, 'utf8');
  const i = c.indexOf(marker);
  if (i < 0) return;
  const j = c.indexOf(marker, i + marker.length);
  if (j < 0) return;
  writeFileSync(p, c.slice(0, j).trimEnd() + '\n');
  console.log(`deduped ${path}`);
}

dedupe('hr/time-tracking/studio/pages/+page.svelte', '\n{#if loading}');
dedupe('finance/accounting/studio/pages/+page.svelte', '\n{#if loading}');

patch('hr/time-tracking/studio/pages/+page.svelte', [
  ['<Plus size={14} /> New Project', '<Plus size={14} /> {m[\'hr.time-tracking.ui.newProjectBtn\']()}'],
  ['<FolderOpen size={13} class="mr-1.5" /> Projects', '<FolderOpen size={13} class="mr-1.5" /> {m[\'hr.time-tracking.tab.projects\']()}'],
  ['<Clock size={13} class="mr-1.5" /> Entries', '<Clock size={13} class="mr-1.5" /> {m[\'hr.time-tracking.tab.entries\']()}'],
  ['<th>Rate</th>', '<th>{m[\'hr.time-tracking.col.rate\']()}</th>'],
  ['<th>Hours</th>', '<th>{m[\'hr.time-tracking.col.hours\']()}</th>'],
  ['<th>Billable</th>', '<th>{m[\'hr.time-tracking.col.billable\']()}</th>'],
  ['No projects yet', '{m[\'hr.time-tracking.empty.projects\']()}'],
  ['No time entries yet', '{m[\'hr.time-tracking.empty.entries\']()}'],
  ['>Billable</span>', '>{m[\'hr.time-tracking.badge.billable\']()}</span>'],
  ['>Internal</span>', '>{m[\'hr.time-tracking.badge.internal\']()}</span>'],
  ['Timer running on', '{m[\'hr.time-tracking.timer.running\']()}'],
  ['(started ', '({m[\'hr.time-tracking.timer.started\']()} '],
  ['Billable project', '{m[\'hr.time-tracking.form.billableProject\']()}'],
  ['<span class="label-text text-xs">Description</span>', '<span class="label-text text-xs">{m[\'hr.time-tracking.ui.description\']()}</span>'],
  ['<span class="label-text text-xs">Client</span>', '<span class="label-text text-xs">{m[\'common.col.client\']()}</span>'],
  ['<span class="label-text text-xs">Currency</span>', '<span class="label-text text-xs">{m[\'common.col.currency\']()}</span>'],
  ['{/if}Create', '{/if}{m[\'common.create\']()}'],
  ['{/if}Start', '{/if}{m[\'hr.time-tracking.ui.startTimerBtn\']()}'],
]);

patch('finance/accounting/studio/pages/+page.svelte', [
  ['<Plus size={14} /> New entry', '<Plus size={14} /> {m[\'finance.accounting.newEntry\']()}'],
  ['<Plus size={14} /> New account', '<Plus size={14} /> {m[\'finance.banking.newAccount\']()}'],
  ['<BookOpen size={13} class="mr-1.5" /> Journal entries', '<BookOpen size={13} class="mr-1.5" /> {m[\'finance.accounting.tab.entries\']()}'],
  ['<Coins size={13} class="mr-1.5" /> Chart of accounts', '<Coins size={13} class="mr-1.5" /> {m[\'finance.accounting.tab.accounts\']()}'],
  ['<TrendingUp size={13} class="mr-1.5" /> Fiscal years', '<TrendingUp size={13} class="mr-1.5" /> {m[\'finance.accounting.tab.fiscal\']()}'],
  ['<span class="label-text text-xs">Date</span>', '<span class="label-text text-xs">{m[\'common.col.date\']()}</span>'],
  ['<span class="label-text text-xs">Description</span>', '<span class="label-text text-xs">{m[\'common.col.description\']()}</span>'],
  ['<span class="text-sm font-medium">Lines</span>', '<span class="text-sm font-medium">{m[\'finance.accounting.ui.lines\']()}</span>'],
  [' Add line', ' {m[\'finance.accounting.ui.addLine\']()}'],
  ['Off by ', '{m[\'finance.accounting.ui.offBy\']()} '],
  [' Post entry', ' {m[\'finance.accounting.postEntry\']()}'],
  ['<span class="label-text text-xs">Name</span>', '<span class="label-text text-xs">{m[\'common.col.name\']()}</span>'],
  ['<span class="label-text text-xs">Type</span>', '<span class="label-text text-xs">{m[\'common.col.type\']()}</span>'],
  ['>Expense</option>', '>{m[\'finance.accounting.ui.expense\']()}</option>'],
  ['No journal entries.', '{m[\'finance.accounting.ui.no_journal_entries\']()}'],
  ["{f.is_closed ? 'closed' : 'open'}", "{f.is_closed ? m['finance.accounting.status.closed']() : m['finance.accounting.status.open']()}"],
  ['{/if} Create', '{/if}{m[\'common.create\']()}'],
]);

// Add missing key if used
en['finance.accounting.ui.no_journal_entries'] = en['finance.accounting.ui.no_journal_entries'] ?? 'No journal entries.';
ro['finance.accounting.ui.no_journal_entries'] = ro['finance.accounting.ui.no_journal_entries'] ?? 'Nicio înregistrare în jurnal.';

patch('crm/studio/pages/contacts/+page.svelte', [
  ["<script lang=\"ts\">\n  import { onMount }", "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n  import { onMount }"],
  ["{m['communications.mail.tab.contacts']()}", "{m['crm.tab.contacts']()}"],
  ['{total} contacts', "{m['crm.contacts.count']({ count: total })}"],
  ['<th>Company</th>', '<th>{m[\'crm.col.company\']()}</th>'],
  ["{editingContact ? 'Edit Contact' : 'New Contact'}", "{editingContact ? m['crm.ui.editContact']() : m['crm.ui.newContactTitle']()}"],
  ['>Prev</button>', ">{m['common.prev']()}</button>"],
  ['>Next</button>', ">{m['common.next']()}</button>"],
  ['Page {page} of {Math.ceil(total / 20) || 1}', "{m['common.pageOf']({ page: String(page), total: String(Math.ceil(total / 20) || 1) })}"],
  ['aria-label=m[\'common.close\']()', 'aria-label={m[\'common.close\']()}'],
]);

patch('crm/studio/pages/organizations/+page.svelte', [
  ["<script lang=\"ts\">\n  import { onMount }", "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n  import { onMount }"],
  ['aria-label=m[\'common.close\']()', 'aria-label={m[\'common.close\']()}'],
]);

patch('crm/studio/pages/transactions/+page.svelte', [
  ["<script lang=\"ts\">\n  import { onMount }", "<script lang=\"ts\">\n  import { m } from '$lib/i18n.svelte.js';\n  import { onMount }"],
  ['aria-label=m[\'common.close\']()', 'aria-label={m[\'common.close\']()}'],
]);

patch('communications/mail/studio/pages/+page.svelte', [
  ['<Plus class="w-3 h-3" /> New Filter', '<Plus class="w-3 h-3" /> {m[\'communications.mail.ui.newFilterBtn\']()}'],
  ['<Plus class="w-3 h-3" /> New\n', '<Plus class="w-3 h-3" /> {m[\'common.new\']()}\n'],
  ['To: {Array.isArray', "{m['communications.mail.draft.to']} {Array.isArray"],
]);

patch('search/studio/pages/+page.svelte', [
  ['if (!confirm(`Remove search index for "${collection}"?`))', "if (!confirm(m['ext.confirm.removeSearchIndex']({ collection })))"],
]);

patch('storage/cloud/studio/pages/+page.svelte', [
  ['if (!confirm(`Delete ${e.name}?`))', "if (!confirm(m['ext.confirm.deleteNamed']({ name: e.name })))"],
]);

patch('forms/studio/pages/+page.svelte', [
  ['if (!confirm(`Delete form "${name}"? This will also delete all submissions.`))', "if (!confirm(m['ext.confirm.deleteForm']({ name })))"],
]);

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log('i18n-next-batch done');
