<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Landmark, Plus, X, ArrowLeftRight, FileSpreadsheet, LoaderCircle } from '@lucide/svelte';

let tab = $state<'accounts' | 'transactions' | 'reconciliation'>('accounts');
let accounts = $state<any[]>([]);
let transactions = $state<any[]>([]);
let unreconciled = $state<any[]>([]);
let openInvoices = $state<any[]>([]);
let loading = $state(true);
let showForm = $state(false);
let saving = $state(false);
let form = $state({ name: '', bank_name: '', iban: '', currency: 'RON', opening_balance: 0 });

async function loadAccounts() {
  try {
    const r = await api.get<{ data: any[] }>('/ext/finance/banking/accounts');
    accounts = r.data ?? [];
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function loadTransactions() {
  try {
    const r = await api.get<{ data: any[] }>('/ext/finance/banking/transactions?limit=100');
    transactions = r.data ?? [];
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function loadReconciliation() {
  try {
    const [u, inv] = await Promise.all([
      api.get<{ data: any[] }>('/ext/finance/banking/transactions?reconciled=false&limit=100'),
      api
        .get<{ data: any[] }>('/ext/finance/invoicing/invoices?status=sent&limit=100')
        .catch(() => ({ data: [] })),
    ]);
    unreconciled = u.data ?? [];
    openInvoices = inv.data ?? [];
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function loadTab() {
  loading = true;
  if (tab === 'accounts') await loadAccounts();
  else if (tab === 'transactions') await loadTransactions();
  else await loadReconciliation();
  loading = false;
}

async function createAccount() {
  saving = true;
  try {
    await api.post('/ext/finance/banking/accounts', form);
    showForm = false;
    form = { name: '', bank_name: '', iban: '', currency: 'RON', opening_balance: 0 };
    await loadAccounts();
    toast.success(m['ext.created']());
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

$effect(() => {
  tab;
  loadTab();
});
onMount(() => loadAccounts());

function fmt(n: number, c = 'RON') {
  return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: c }).format(n);
}
</script>

<ExtensionPageShell title={m['finance.banking.title']()} subtitle={m['finance.banking.subtitle']()}>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['finance.banking.newAccount']()}
    </button>
  {/snippet}

    <div class="tabs tabs-boxed bg-base-200 w-fit">
      <button class="tab {tab === 'accounts' ? 'tab-active' : ''}" onclick={() => (tab = 'accounts')}>
        <Landmark size={13} class="mr-1.5" aria-hidden="true" />
        {m['finance.banking.tab.accounts']()}
      </button>
      <button class="tab {tab === 'transactions' ? 'tab-active' : ''}" onclick={() => (tab = 'transactions')}>
        <ArrowLeftRight size={13} class="mr-1.5" aria-hidden="true" />
        {m['finance.banking.tab.transactions']()}
      </button>
      <button class="tab {tab === 'reconciliation' ? 'tab-active' : ''}" onclick={() => (tab = 'reconciliation')}>
        <FileSpreadsheet size={13} class="mr-1.5" aria-hidden="true" />
        {m['finance.banking.tab.reconciliation']()}
      </button>
    </div>

    <ExtensionDataPanel
      {loading}
      empty={!loading && tab === 'accounts' && accounts.length === 0}
      emptyTitle={m['finance.banking.empty.accounts']()}
    >
      {#snippet table()}
        {#if tab === 'accounts'}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['common.col.name']()}</th>
                <th>{m['common.col.bank']()}</th>
                <th>{m['common.col.iban']()}</th>
                <th>{m['crm.form.currency']()}</th>
                <th class="text-right">{m['common.col.balance']()}</th>
              </tr>
            </thead>
            <tbody>
              {#each accounts as a (a.id)}
                <tr class="hover">
                  <td class="font-medium text-sm">{a.name}</td>
                  <td class="text-sm">{a.bank_name ?? '—'}</td>
                  <td class="font-mono text-xs">{a.iban}</td>
                  <td class="text-sm">{a.currency}</td>
                  <td class="text-right text-sm">{fmt(Number(a.balance ?? a.opening_balance ?? 0), a.currency)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'transactions'}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['common.col.date']()}</th>
                <th>{m['common.col.description']()}</th>
                <th class="text-right">{m['common.col.amount']()}</th>
                <th>{m['common.col.status']()}</th>
              </tr>
            </thead>
            <tbody>
              {#if transactions.length === 0}
                <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['finance.banking.empty.transactions']()}</td></tr>
              {:else}
                {#each transactions as t (t.id)}
                  <tr class="hover">
                    <td class="text-xs">{t.transaction_date?.slice(0, 10) ?? '—'}</td>
                    <td class="text-sm max-w-xs truncate">{t.description ?? '—'}</td>
                    <td class="text-right text-sm">{fmt(Number(t.amount), t.currency)}</td>
                    <td><span class="badge badge-sm badge-ghost">{t.reconciled ? m['finance.banking.status.reconciled']() : m['finance.banking.status.pending']()}</span></td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        {:else}
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-0">
                <div class="p-3 font-medium text-sm border-b border-base-300">{m['finance.banking.section.unreconciled']()}</div>
                <table class="table table-sm">
                  <thead>
                    <tr>
                      <th>{m['common.col.date']()}</th>
                      <th>{m['common.col.description']()}</th>
                      <th class="text-right">{m['common.col.amount']()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#if unreconciled.length === 0}
                      <tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">{m['finance.banking.empty.unreconciled']()}</td></tr>
                    {:else}
                      {#each unreconciled as t (t.id)}
                        <tr class="hover">
                          <td class="text-xs">{t.transaction_date?.slice(0, 10) ?? '—'}</td>
                          <td class="text-sm truncate">{t.description ?? '—'}</td>
                          <td class="text-right text-sm">{fmt(Number(t.amount), t.currency)}</td>
                        </tr>
                      {/each}
                    {/if}
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card bg-base-200 border border-base-300">
              <div class="card-body p-0">
                <div class="p-3 font-medium text-sm border-b border-base-300">{m['finance.banking.section.openInvoices']()}</div>
                <table class="table table-sm">
                  <thead>
                    <tr>
                      <th>{m['common.col.number']()}</th>
                      <th>{m['common.col.client']()}</th>
                      <th class="text-right">{m['common.col.total']()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#if openInvoices.length === 0}
                      <tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">{m['finance.banking.ui.no_open_invoices']()}</td></tr>
                    {:else}
                      {#each openInvoices as i (i.id)}
                        <tr class="hover">
                          <td class="font-mono text-xs">{i.number}</td>
                          <td class="text-sm">{i.client_name}</td>
                          <td class="text-right text-sm">{fmt(Number(i.total))}</td>
                        </tr>
                      {/each}
                    {/if}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        {/if}
      {/snippet}
    </ExtensionDataPanel>
</ExtensionPageShell>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['finance.banking.ui.new_bank_account']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.banking.ui.internal_name']()}</span></label>
          <input class="input input-sm" bind:value={form.name} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.bank']()}</span></label>
          <input class="input input-sm" bind:value={form.bank_name} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.iban']()}</span></label>
          <input class="input input-sm font-mono" bind:value={form.iban} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
          <input class="input input-sm" bind:value={form.currency} maxlength={3} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.banking.ui.opening_balance']()}</span></label>
          <input type="number" step="0.01" class="input input-sm" bind:value={form.opening_balance} />
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name || !form.iban} onclick={createAccount}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
