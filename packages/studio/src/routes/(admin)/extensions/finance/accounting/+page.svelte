<script lang="ts">
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
    description: '', document_number: '',
    lines: [
      { account_code: '', description: '', debit: 0, credit: 0 },
      { account_code: '', description: '', debit: 0, credit: 0 },
    ] as any[],
  });
  let accountForm = $state({ code: '', name: '', account_type: 'asset', parent_code: '' });

  const sums = $derived({
    debit: entryForm.lines.reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0),
    credit: entryForm.lines.reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0),
    get balanced() { return Math.abs(this.debit - this.credit) < 0.005; },
  });

  async function loadEntries() { try { const r = await api.get<{ data: any[] }>('/api/accounting/journal-entries?limit=100'); entries = r.data ?? []; } catch (e: any) { toast.error(e?.message ?? 'Error'); } }
  async function loadAccounts() { try { const r = await api.get<{ data: any[] }>('/api/accounting/accounts'); accounts = r.data ?? []; } catch (e: any) { toast.error(e?.message ?? 'Error'); } }
  async function loadFiscal() { try { const r = await api.get<{ data: any[] }>('/api/accounting/fiscal-years'); fiscalYears = r.data ?? []; } catch (e: any) { toast.error(e?.message ?? 'Error'); } }

  async function loadTab() {
    loading = true;
    if (tab === 'entries') await loadEntries();
    else if (tab === 'accounts') await loadAccounts();
    else await loadFiscal();
    loading = false;
  }

  function addLine() { entryForm.lines = [...entryForm.lines, { account_code: '', description: '', debit: 0, credit: 0 }]; }
  function removeLine(idx: number) { entryForm.lines = entryForm.lines.filter((_: any, i: number) => i !== idx); }

  async function createEntry() {
    saving = true;
    try {
      await api.post('/api/accounting/journal-entries', entryForm);
      showEntryForm = false;
      entryForm = { entry_date: new Date().toISOString().slice(0, 10), description: '', document_number: '',
        lines: [{ account_code: '', description: '', debit: 0, credit: 0 }, { account_code: '', description: '', debit: 0, credit: 0 }] };
      await loadEntries();
      toast.success('Entry posted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function createAccount() {
    saving = true;
    try {
      await api.post('/api/accounting/accounts', accountForm);
      showAccountForm = false;
      accountForm = { code: '', name: '', account_type: 'asset', parent_code: '' };
      await loadAccounts();
      toast.success('Account created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  $effect(() => { tab; loadTab(); });
  onMount(() => { loadEntries(); loadAccounts(); });

  function fmt(n: number) { return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' }).format(n); }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Calculator size={20} /> Accounting</h1>
      <p class="text-sm text-base-content/50">Journal entries, chart of accounts, and fiscal years</p>
    </div>
    <div>
      {#if tab === 'entries'}<button class="btn btn-primary btn-sm gap-1" onclick={() => (showEntryForm = true)}><Plus size={14} /> New entry</button>{/if}
      {#if tab === 'accounts'}<button class="btn btn-primary btn-sm gap-1" onclick={() => (showAccountForm = true)}><Plus size={14} /> New account</button>{/if}
    </div>
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'entries' ? 'tab-active' : ''}" onclick={() => (tab = 'entries')}><BookOpen size={13} class="mr-1.5" /> Journal entries</button>
    <button class="tab {tab === 'accounts' ? 'tab-active' : ''}" onclick={() => (tab = 'accounts')}><Coins size={13} class="mr-1.5" /> Chart of accounts</button>
    <button class="tab {tab === 'fiscal' ? 'tab-active' : ''}" onclick={() => (tab = 'fiscal')}><TrendingUp size={13} class="mr-1.5" /> Fiscal years</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'entries'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Date</th><th>Doc #</th><th>Description</th><th class="text-right">Debit</th><th class="text-right">Credit</th><th>Status</th></tr></thead>
        <tbody>
          {#if entries.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">No journal entries.</td></tr>
          {:else}{#each entries as e (e.id)}
            <tr class="hover"><td class="text-xs">{e.entry_date}</td><td class="font-mono text-xs">{e.document_number ?? '—'}</td><td class="text-sm">{e.description}</td><td class="text-right text-sm">{fmt(Number(e.total_debit ?? 0))}</td><td class="text-right text-sm">{fmt(Number(e.total_credit ?? 0))}</td><td><span class="badge badge-sm">{e.status ?? 'posted'}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'accounts'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Parent</th></tr></thead>
        <tbody>
          {#if accounts.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No accounts.</td></tr>
          {:else}{#each accounts as a (a.code)}
            <tr class="hover"><td class="font-mono text-sm">{a.code}</td><td class="text-sm">{a.name}</td><td><span class="badge badge-ghost badge-sm">{a.account_type}</span></td><td class="font-mono text-xs">{a.parent_code ?? '—'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Year</th><th>Start</th><th>End</th><th>Status</th></tr></thead>
        <tbody>
          {#if fiscalYears.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No fiscal years.</td></tr>
          {:else}{#each fiscalYears as f (f.id)}
            <tr class="hover"><td class="text-sm">{f.name}</td><td class="text-xs">{f.start_date}</td><td class="text-xs">{f.end_date}</td><td><span class="badge badge-sm">{f.is_closed ? 'closed' : 'open'}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showEntryForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New journal entry</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showEntryForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Date</span></label><input type="date" class="input input-sm" bind:value={entryForm.entry_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Document #</span></label><input class="input input-sm" bind:value={entryForm.document_number} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Description</span></label><input class="input input-sm" bind:value={entryForm.description} /></div>
      </div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-medium">Lines</span>
        <button class="btn btn-ghost btn-xs gap-1" onclick={addLine}><Plus size={12} /> Add line</button>
      </div>
      <table class="table table-xs">
        <thead><tr><th>Account</th><th>Description</th><th class="text-right">Debit</th><th class="text-right">Credit</th><th></th></tr></thead>
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
            <td colspan="2" class="text-right text-xs">Totals</td>
            <td class="text-right text-xs">{fmt(sums.debit)}</td>
            <td class="text-right text-xs">{fmt(sums.credit)}</td>
            <td>{#if !sums.balanced}<span class="text-error text-xs">Off by {fmt(Math.abs(sums.debit - sums.credit))}</span>{/if}</td>
          </tr>
        </tbody>
      </table>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showEntryForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !sums.balanced || sums.debit === 0 || !entryForm.description} onclick={createEntry}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Post entry
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showAccountForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New account</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showAccountForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Code (e.g. 4111)</span></label><input class="input input-sm font-mono" bind:value={accountForm.code} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Name</span></label><input class="input input-sm" bind:value={accountForm.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Type</span></label>
          <select class="select select-sm" bind:value={accountForm.account_type}>
            <option value="asset">Asset</option><option value="liability">Liability</option>
            <option value="equity">Equity</option><option value="revenue">Revenue</option><option value="expense">Expense</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Parent code (optional)</span></label><input class="input input-sm font-mono" bind:value={accountForm.parent_code} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showAccountForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !accountForm.code || !accountForm.name} onclick={createAccount}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
