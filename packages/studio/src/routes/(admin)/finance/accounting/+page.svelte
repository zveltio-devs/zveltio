<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Calculator, Plus, X, BookOpen, Coins, TrendingUp, LoaderCircle } from '@lucide/svelte';

let tab = $state<'entries' | 'accounts' | 'fiscal'>('entries');
let entries = $state<any[]>([]);
let accounts = $state<any[]>([]);
let fiscalYears = $state<any[]>([]);
let loading = $state(true);
let showEntryForm = $state(false);
let showAccountForm = $state(false);
let saving = $state(false);

let entryForm = $state({
  entry_date: new Date().toISOString().slice(0, 10),
  description: '',
  document_number: '',
  lines: [
    { account_code: '', description: '', debit: 0, credit: 0 },
    { account_code: '', description: '', debit: 0, credit: 0 },
  ] as any[],
});
let accountForm = $state({ code: '', name: '', account_type: 'asset', parent_code: '' });

const sums = $derived({
  debit: entryForm.lines.reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0),
  credit: entryForm.lines.reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0),
  get balanced() {
    return Math.abs(this.debit - this.credit) < 0.005;
  },
});

async function loadEntries() {
  try {
    const r = await api.get<{ data: any[] }>('/ext/finance/accounting/journal-entries?limit=100');
    entries = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}
async function loadAccounts() {
  try {
    const r = await api.get<{ data: any[] }>('/ext/finance/accounting/accounts');
    accounts = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}
async function loadFiscal() {
  try {
    const r = await api.get<{ data: any[] }>('/ext/finance/accounting/fiscal-years');
    fiscalYears = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function loadTab() {
  loading = true;
  if (tab === 'entries') await loadEntries();
  else if (tab === 'accounts') await loadAccounts();
  else await loadFiscal();
  loading = false;
}

function addLine() {
  entryForm.lines = [
    ...entryForm.lines,
    { account_code: '', description: '', debit: 0, credit: 0 },
  ];
}
function removeLine(idx: number) {
  entryForm.lines = entryForm.lines.filter((_: any, i: number) => i !== idx);
}

async function createEntry() {
  saving = true;
  try {
    await api.post('/ext/finance/accounting/journal-entries', entryForm);
    showEntryForm = false;
    entryForm = {
      entry_date: new Date().toISOString().slice(0, 10),
      description: '',
      document_number: '',
      lines: [
        { account_code: '', description: '', debit: 0, credit: 0 },
        { account_code: '', description: '', debit: 0, credit: 0 },
      ],
    };
    await loadEntries();
    toast.success(m['finance.accounting.toast.posted']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function createAccount() {
  saving = true;
  try {
    await api.post('/ext/finance/accounting/accounts', accountForm);
    showAccountForm = false;
    accountForm = { code: '', name: '', account_type: 'asset', parent_code: '' };
    await loadAccounts();
    toast.success(m['ext.created']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

$effect(() => {
  tab;
  loadTab();
});
onMount(() => {
  loadEntries();
  loadAccounts();
});

function fmt(n: number) {
  return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' }).format(n);
}
</script>

<ExtensionPageShell title={m['finance.accounting.title']()} subtitle={m['finance.accounting.subtitle']()}>
<div class="flex gap-2">
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showEntryForm = true)}><Plus size={14} /> {m['finance.accounting.newEntry']()}</button>
      <button type="button" class="btn btn-outline btn-sm gap-1" onclick={() => (showAccountForm = true)}><Plus size={14} /> {m['finance.banking.newAccount']()}</button>
    </div>

<div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'entries' ? 'tab-active' : ''}" onclick={() => (tab = 'entries')}><BookOpen size={13} class="mr-1.5" /> {m['finance.accounting.tab.entries']()}</button>
    <button class="tab {tab === 'accounts' ? 'tab-active' : ''}" onclick={() => (tab = 'accounts')}><Coins size={13} class="mr-1.5" /> {m['finance.accounting.tab.accounts']()}</button>
    <button class="tab {tab === 'fiscal' ? 'tab-active' : ''}" onclick={() => (tab = 'fiscal')}><TrendingUp size={13} class="mr-1.5" /> {m['finance.accounting.tab.fiscal']()}</button>
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'entries'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.date']()}</th><th>{m['common.col.docNumber']()}</th><th>{m['common.col.description']()}</th><th class="text-right">{m['common.col.debit']()}</th><th class="text-right">{m['common.col.credit']()}</th><th>{m['common.col.status']()}</th></tr></thead>
        <tbody>
          {#if entries.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">{m['compliance.ro.saft.ui.no_journal_entries']()}</td></tr>
          {:else}{#each entries as e (e.id)}
            <tr class="hover"><td class="text-xs">{e.entry_date}</td><td class="font-mono text-xs">{e.document_number ?? '—'}</td><td class="text-sm">{e.description}</td><td class="text-right text-sm">{fmt(Number(e.total_debit ?? 0))}</td><td class="text-right text-sm">{fmt(Number(e.total_credit ?? 0))}</td><td><span class="badge badge-sm">{e.status ?? 'posted'}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'accounts'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.code']()}</th><th>{m['common.col.name']()}</th><th>{m['common.col.type']()}</th><th>{m['common.col.parent']()}</th></tr></thead>
        <tbody>
          {#if accounts.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['finance.accounting.ui.no_accounts']()}</td></tr>
          {:else}{#each accounts as a (a.code)}
            <tr class="hover"><td class="font-mono text-sm">{a.code}</td><td class="text-sm">{a.name}</td><td><span class="badge badge-ghost badge-sm">{a.account_type}</span></td><td class="font-mono text-xs">{a.parent_code ?? '—'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.year']()}</th><th>{m['common.col.start']()}</th><th>{m['common.col.end']()}</th><th>{m['common.col.status']()}</th></tr></thead>
        <tbody>
          {#if fiscalYears.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['finance.accounting.ui.no_fiscal_years']()}</td></tr>
          {:else}{#each fiscalYears as f (f.id)}
            <tr class="hover"><td class="text-sm">{f.name}</td><td class="text-xs">{f.start_date}</td><td class="text-xs">{f.end_date}</td><td><span class="badge badge-sm">{f.is_closed ? m['finance.accounting.status.closed']() : m['finance.accounting.status.open']()}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</ExtensionPageShell>

{#if showEntryForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['finance.accounting.ui.new_journal_entry']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showEntryForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.date']()}</span></label><input type="date" class="input input-sm" bind:value={entryForm.entry_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.accounting.ui.document']()}</span></label><input class="input input-sm" bind:value={entryForm.document_number} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">{m['common.col.description']()}</span></label><input class="input input-sm" bind:value={entryForm.description} /></div>
      </div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-medium">{m['finance.accounting.ui.lines']()}</span>
        <button class="btn btn-ghost btn-xs gap-1" onclick={addLine}><Plus size={12} /> {m['finance.accounting.ui.addLine']()}</button>
      </div>
      <table class="table table-xs">
        <thead><tr><th>{m['common.col.account']()}</th><th>{m['common.col.description']()}</th><th class="text-right">{m['common.col.debit']()}</th><th class="text-right">{m['common.col.credit']()}</th><th></th></tr></thead>
        <tbody>
          {#each entryForm.lines as line, idx}
            <tr>
              <td><select class="select select-xs w-36" bind:value={line.account_code}><option value="">—</option>{#each accounts as a (a.code)}<option value={a.code}>{a.code} {a.name}</option>{/each}</select></td>
              <td><input class="input input-xs w-full" bind:value={line.description} /></td>
              <td><input type="number" step="0.01" class="input input-xs w-24 text-right" bind:value={line.debit} /></td>
              <td><input type="number" step="0.01" class="input input-xs w-24 text-right" bind:value={line.credit} /></td>
              <td>{#if entryForm.lines.length > 2}<button class="btn btn-ghost btn-xs" onclick={() => removeLine(idx)}><X size={11} /></button>{/if}</td>
            </tr>
          {/each}
          <tr class="font-medium">
            <td colspan="2" class="text-right text-xs">{m['finance.accounting.ui.totals']()}</td>
            <td class="text-right text-xs">{fmt(sums.debit)}</td>
            <td class="text-right text-xs">{fmt(sums.credit)}</td>
            <td>{#if !sums.balanced}<span class="text-error text-xs">{m['finance.accounting.ui.offBy']()} {fmt(Math.abs(sums.debit - sums.credit))}</span>{/if}</td>
          </tr>
        </tbody>
      </table>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showEntryForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !sums.balanced || sums.debit === 0 || !entryForm.description} onclick={createEntry}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['finance.accounting.postEntry']()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showAccountForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['finance.banking.newAccount']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showAccountForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.accounting.ui.code_e_g_4111']()}</span></label><input class="input input-sm font-mono" bind:value={accountForm.code} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.name']()}</span></label><input class="input input-sm" bind:value={accountForm.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.type']()}</span></label>
          <select class="select select-sm" bind:value={accountForm.account_type}>
            <option value="asset">{m['finance.accounting.ui.asset']()}</option><option value="liability">{m['finance.accounting.ui.liability']()}</option>
            <option value="equity">{m['finance.accounting.ui.equity']()}</option><option value="revenue">{m['finance.accounting.ui.revenue']()}</option><option value="expense">{m['compliance.ro.saft.ui.expense']()}</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.accounting.ui.parent_code_optional']()}</span></label><input class="input input-sm font-mono" bind:value={accountForm.parent_code} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showAccountForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !accountForm.code || !accountForm.name} onclick={createAccount}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}{m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
