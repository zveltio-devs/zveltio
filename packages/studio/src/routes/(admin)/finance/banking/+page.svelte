<script lang="ts">
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

  async function loadAccounts() { try { const r = await api.get<{ data: any[] }>('/ext/finance/banking/accounts'); accounts = r.data ?? []; } catch (e: any) { toast.error(e?.message ?? 'Error'); } }
  async function loadTransactions() { try { const r = await api.get<{ data: any[] }>('/ext/finance/banking/transactions?limit=100'); transactions = r.data ?? []; } catch (e: any) { toast.error(e?.message ?? 'Error'); } }
  async function loadReconciliation() {
    try {
      const [u, inv] = await Promise.all([
        api.get<{ data: any[] }>('/ext/finance/banking/transactions?reconciled=false&limit=100'),
        api.get<{ data: any[] }>('/ext/finance/invoicing/invoices?status=sent&limit=100').catch(() => ({ data: [] })),
      ]);
      unreconciled = u.data ?? [];
      openInvoices = inv.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
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
      toast.success('Account created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  $effect(() => { tab; loadTab(); });
  onMount(() => loadAccounts());

  function fmt(n: number, c = 'RON') { return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: c }).format(n); }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Landmark size={20} /> Banking</h1>
      <p class="text-sm text-base-content/50">Bank accounts, transactions, and reconciliation</p>
    </div>
    {#if tab === 'accounts'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New account</button>
    {/if}
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'accounts' ? 'tab-active' : ''}" onclick={() => (tab = 'accounts')}><Landmark size={13} class="mr-1.5" /> Accounts</button>
    <button class="tab {tab === 'transactions' ? 'tab-active' : ''}" onclick={() => (tab = 'transactions')}><FileSpreadsheet size={13} class="mr-1.5" /> Transactions</button>
    <button class="tab {tab === 'reconciliation' ? 'tab-active' : ''}" onclick={() => (tab = 'reconciliation')}><ArrowLeftRight size={13} class="mr-1.5" /> Reconciliation</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'accounts'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Name</th><th>Bank</th><th>IBAN</th><th>Currency</th><th class="text-right">Balance</th></tr></thead>
        <tbody>
          {#if accounts.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No accounts.</td></tr>
          {:else}{#each accounts as a (a.id)}
            <tr class="hover"><td class="text-sm">{a.name}</td><td class="text-sm">{a.bank_name}</td><td class="font-mono text-xs">{a.iban}</td><td class="text-sm">{a.currency}</td><td class="text-right text-sm">{fmt(Number(a.balance), a.currency)}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'transactions'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Date</th><th>Account</th><th>Description</th><th class="text-right">Amount</th><th>Reconciled</th></tr></thead>
        <tbody>
          {#if transactions.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No transactions yet — import a bank statement to start.</td></tr>
          {:else}{#each transactions as t (t.id)}
            <tr class="hover"><td class="text-xs">{t.transaction_date}</td><td class="text-sm">{t.account_name ?? '—'}</td><td class="max-w-xs truncate text-sm">{t.description}</td><td class="text-right text-sm {Number(t.amount) < 0 ? 'text-error' : 'text-success'}">{fmt(Number(t.amount), t.currency)}</td><td>{t.reconciled ? '✓' : '—'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 font-medium text-sm border-b border-base-300">Unreconciled transactions</div>
          <table class="table table-sm">
            <thead><tr><th>Date</th><th>Description</th><th class="text-right">Amount</th></tr></thead>
            <tbody>
              {#if unreconciled.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">All clear.</td></tr>
              {:else}{#each unreconciled as t (t.id)}<tr class="hover"><td class="text-xs">{t.transaction_date}</td><td class="max-w-xs truncate text-sm">{t.description}</td><td class="text-right text-sm">{fmt(Number(t.amount))}</td></tr>{/each}{/if}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 font-medium text-sm border-b border-base-300">Open invoices (sent)</div>
          <table class="table table-sm">
            <thead><tr><th>Number</th><th>Client</th><th class="text-right">Total</th></tr></thead>
            <tbody>
              {#if openInvoices.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">No open invoices.</td></tr>
              {:else}{#each openInvoices as i (i.id)}<tr class="hover"><td class="font-mono text-xs">{i.number}</td><td class="text-sm">{i.client_name}</td><td class="text-right text-sm">{fmt(Number(i.total))}</td></tr>{/each}{/if}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New bank account</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Internal name</span></label><input class="input input-sm" bind:value={form.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Bank</span></label><input class="input input-sm" bind:value={form.bank_name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">IBAN</span></label><input class="input input-sm font-mono" bind:value={form.iban} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label><input class="input input-sm" bind:value={form.currency} maxlength={3} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Opening balance</span></label><input type="number" step="0.01" class="input input-sm" bind:value={form.opening_balance} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name || !form.iban} onclick={createAccount}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
