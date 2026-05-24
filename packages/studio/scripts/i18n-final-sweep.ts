#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const STUDIO = join(import.meta.dir, '..');
const EXT = join(STUDIO, '..', '..', '..', 'zveltio-extensions');
const EN = join(STUDIO, 'messages/en.json');
const RO = join(STUDIO, 'messages/ro.json');

const en = JSON.parse(readFileSync(EN, 'utf8')) as Record<string, string>;
const ro = JSON.parse(readFileSync(RO, 'utf8')) as Record<string, string>;

const KEYS: Record<string, { en: string; ro: string }> = {
  'finance.banking.tab.accounts': { en: 'Accounts', ro: 'Conturi' },
  'finance.banking.tab.transactions': { en: 'Transactions', ro: 'Tranzacții' },
  'finance.banking.tab.reconciliation': { en: 'Reconciliation', ro: 'Reconciliere' },
  'finance.banking.empty.accounts': { en: 'No bank accounts yet.', ro: 'Niciun cont bancar încă.' },
  'finance.banking.empty.transactions': { en: 'No transactions yet.', ro: 'Nicio tranzacție încă.' },
  'finance.banking.empty.unreconciled': { en: 'No unreconciled transactions.', ro: 'Nicio tranzacție nereconciliată.' },
  'finance.banking.section.unreconciled': { en: 'Unreconciled transactions', ro: 'Tranzacții nereconciliate' },
  'finance.banking.section.openInvoices': { en: 'Open invoices (sent)', ro: 'Facturi deschise (trimise)' },
  'finance.banking.status.reconciled': { en: 'Reconciled', ro: 'Reconciliat' },
  'finance.banking.status.pending': { en: 'Pending', ro: 'În așteptare' },
  'finance.subscriptions.tab.subscribers': { en: 'Subscribers', ro: 'Abonați' },
  'finance.subscriptions.tab.plans': { en: 'Plans', ro: 'Planuri' },
  'finance.subscriptions.tab.dunning': { en: 'Dunning', ro: 'Recuperări' },
  'finance.subscriptions.btn.newPlan': { en: 'New plan', ro: 'Plan nou' },
  'finance.subscriptions.col.subscriber': { en: 'Subscriber', ro: 'Abonat' },
  'finance.subscriptions.col.plan': { en: 'Plan', ro: 'Plan' },
  'finance.subscriptions.col.started': { en: 'Started', ro: 'Început' },
  'finance.subscriptions.col.nextBill': { en: 'Next bill', ro: 'Următoarea factură' },
  'finance.subscriptions.col.mrr': { en: 'MRR', ro: 'MRR' },
  'finance.subscriptions.col.attempt': { en: 'Attempt #', ro: 'Încercare #' },
  'finance.subscriptions.col.lastAttempt': { en: 'Last attempt', ro: 'Ultima încercare' },
  'common.create': { en: 'Create', ro: 'Creează' },
  'projects.management.title': { en: 'Projects', ro: 'Proiecte' },
  'workflow.checklists.btn.new': { en: 'New Checklist', ro: 'Checklist nou' },
  'workflow.checklists.btn.save': { en: 'Save', ro: 'Salvează' },
  'workflow.checklists.btn.back': { en: '← Back', ro: '← Înapoi' },
  'workflow.checklists.section.new': { en: 'New Checklist', ro: 'Checklist nou' },
  'workflow.checklists.empty.list': { en: 'No checklists yet', ro: 'Nicio checklist încă' },
  'workflow.checklists.empty.listHint': { en: 'Create your first checklist to get started.', ro: 'Creează primul checklist pentru a începe.' },
  'workflow.approvals.tab.requests': { en: 'Requests', ro: 'Cereri' },
  'workflow.approvals.tab.workflows': { en: 'Workflows', ro: 'Fluxuri' },
  'workflow.approvals.empty.requests': { en: 'No approval requests found.', ro: 'Nicio cerere de aprobare.' },
  'workflow.approvals.empty.workflows': { en: 'No workflows configured.', ro: 'Niciun flux configurat.' },
  'content.document-templates.btn.new': { en: 'New template', ro: 'Șablon nou' },
  'finance.accounting.actions': { en: 'Journal actions', ro: 'Acțiuni jurnal' },
};

for (const [k, v] of Object.entries(KEYS)) {
  en[k] = v.en;
  ro[k] = v.ro;
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

dedupeAtSecond('finance/subscriptions/studio/pages/+page.svelte', '{#if showPlanForm}');

patch('workflow/checklists/studio/pages/+page.svelte', [
  ['← Back', "{m['workflow.checklists.btn.back']()}"],
  ['<Plus size={14}/> New Checklist', '<Plus size={14}/> {m[\'workflow.checklists.btn.new\']()}'],
  ['{/if}\n        Save', '{/if}\n        {m[\'workflow.checklists.btn.save\']()}'],
  ['<h4 class="font-semibold text-sm">New Checklist</h4>', '<h4 class="font-semibold text-sm">{m[\'workflow.checklists.section.new\']()}</h4>'],
  ['No checklists yet', "{m['workflow.checklists.empty.list']()}"],
  ['Create your first checklist to get started.', "{m['workflow.checklists.empty.listHint']()}"],
]);

patch('workflow/approvals/studio/pages/+page.svelte', [
  ['<CheckSquare size={13} class="mr-1.5" /> Requests', '<CheckSquare size={13} class="mr-1.5" aria-hidden="true" /> {m[\'workflow.approvals.tab.requests\']()}'],
  ['>Workflows</button>', ">{m['workflow.approvals.tab.workflows']()}</button>"],
  ['No approval requests found.', "{m['workflow.approvals.empty.requests']()}"],
  ['No workflows configured.', "{m['workflow.approvals.empty.workflows']()}"],
]);

patch('content/document-templates/studio/pages/+page.svelte', [
  ['New template', "{m['content.document-templates.btn.new']()}"],
]);

patch('finance/subscriptions/studio/pages/+page.svelte', [
  ['<Plus size={14} /> New plan</button>', '<Plus size={14} /> {m[\'finance.subscriptions.btn.newPlan\']()}</button>'],
  ['>Subscribers</button>', ">{m['finance.subscriptions.tab.subscribers']()}</button>"],
  ['>Plans</button>', ">{m['finance.subscriptions.tab.plans']()}</button>"],
  ['<AlertCircle size={13} class="mr-1.5" /> Dunning', '<AlertCircle size={13} class="mr-1.5" aria-hidden="true" /> {m[\'finance.subscriptions.tab.dunning\']()}'],
  ['<th>Subscriber</th>', '<th>{m[\'finance.subscriptions.col.subscriber\']()}</th>'],
  ['<th>Plan</th>', '<th>{m[\'finance.subscriptions.col.plan\']()}</th>'],
  ['<th>Started</th>', '<th>{m[\'finance.subscriptions.col.started\']()}</th>'],
  ['<th>Next bill</th>', '<th>{m[\'finance.subscriptions.col.nextBill\']()}</th>'],
  ['<th class="text-right">MRR</th>', '<th class="text-right">{m[\'finance.subscriptions.col.mrr\']()}</th>'],
  ['<th>Attempt #</th>', '<th>{m[\'finance.subscriptions.col.attempt\']()}</th>'],
  ['<th>Last attempt</th>', '<th>{m[\'finance.subscriptions.col.lastAttempt\']()}</th>'],
  ['<th>Interval</th>', '<th>{m[\'finance.subscriptions.ui.interval\']()}</th>'],
  ['<th>Trial days</th>', '<th>{m[\'finance.subscriptions.ui.trial_days\']()}</th>'],
  ['{/if} Create', '{/if}{m[\'common.create\']()}'],
]);

// Global TH replacements still missing in some pages
const TH: [string, string][] = [
  ['<th>Interval</th>', '<th>{m[\'finance.subscriptions.ui.interval\']()}</th>'],
];

function walkSvelte(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSvelte(p, out);
    else if (e.name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

let thFixed = 0;
for (const p of walkSvelte(EXT)) {
  let c = readFileSync(p, 'utf8');
  const o = c;
  for (const [a, b] of TH) c = c.replaceAll(a, b);
  if (c !== o) {
    writeFileSync(p, c);
    thFixed++;
  }
}

writeFileSync(EN, JSON.stringify(en, null, 2) + '\n');
writeFileSync(RO, JSON.stringify(ro, null, 2) + '\n');
console.log(`i18n-final-sweep done, th patches: ${thFixed}`);
