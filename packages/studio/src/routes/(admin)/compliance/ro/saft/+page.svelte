<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { ENGINE_URL } from '$lib/config.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, Download, Send, Trash2, FileSpreadsheet, RefreshCw, LoaderCircle } from '@lucide/svelte';

  let activeTab = $state<'exports' | 'accounts' | 'entries'>('exports');
  let exports_ = $state<any[]>([]);
  let accounts = $state<any[]>([]);
  let entries = $state<any[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let showAccountModal = $state(false);
  let showEntryModal = $state(false);
  let creating = $state(false);

  let exportForm = $state({
    period_start: new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0],
    period_end: new Date().toISOString().split('T')[0],
    company_name: '',
    company_cui: '',
    company_address: '',
  });

  let accountForm = $state({ code: '', description: '', account_type: 'balance' });
  let entryForm = $state({
    account_code: '',
    entry_date: new Date().toISOString().split('T')[0],
    description: '',
    debit: 0,
    credit: 0,
    document_number: '',
  });

  onMount(loadAll);

  async function loadAll() {
    loading = true;
    try {
      const [expR, accR, entR] = await Promise.allSettled([
        api.get<{ exports: any[] }>('/ext/compliance/ro/saft'),
        api.get<{ accounts: any[] }>('/ext/compliance/ro/saft/accounts'),
        api.get<{ entries: any[] }>('/ext/compliance/ro/saft/entries'),
      ]);
      if (expR.status === 'fulfilled') exports_ = expR.value.exports ?? [];
      if (accR.status === 'fulfilled') accounts = accR.value.accounts ?? [];
      if (entR.status === 'fulfilled') entries = entR.value.entries ?? [];
    } finally { loading = false; }
  }

  async function createExport() {
    if (!exportForm.company_name || !exportForm.company_cui) return;
    creating = true;
    try {
      await api.post('/ext/compliance/ro/saft', exportForm);
      showCreateModal = false;
      const r = await api.get<{ exports: any[] }>('/ext/compliance/ro/saft');
      exports_ = r.exports ?? [];
      toast.success('Export creat.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function generateXML(id: string) {
    try {
      await api.post(`/ext/compliance/ro/saft/${id}/generate`, {});
      toast.success('SAF-T XML generat!');
      const r = await api.get<{ exports: any[] }>('/ext/compliance/ro/saft');
      exports_ = r.exports ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to generate XML'); }
  }

  async function downloadXML(id: string, start: string, end: string) {
    const res = await api.fetch(`/ext/compliance/ro/saft/${id}/xml`);
    if (!res.ok) { toast.error('Genereaza XML mai intai'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `SAFT_${start}_${end}.xml`; a.click();
    URL.revokeObjectURL(url);
  }

  async function submitToANAF(id: string) {
    if (!confirm('Trimite SAF-T la ANAF?')) return;
    try {
      await api.post(`/ext/compliance/ro/saft/${id}/submit`, {});
      toast.success('Trimis la ANAF!');
      const r = await api.get<{ exports: any[] }>('/ext/compliance/ro/saft');
      exports_ = r.exports ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Submission failed'); }
  }

  async function deleteExport(id: string) {
    if (!confirm('Sterge exportul?')) return;
    try { await api.delete(`/ext/compliance/ro/saft/${id}`); exports_ = exports_.filter((e) => e.id !== id); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function createAccount() {
    if (!accountForm.code || !accountForm.description) return;
    creating = true;
    try {
      await api.post('/ext/compliance/ro/saft/accounts', accountForm);
      showAccountModal = false;
      accountForm = { code: '', description: '', account_type: 'balance' };
      const r = await api.get<{ accounts: any[] }>('/ext/compliance/ro/saft/accounts');
      accounts = r.accounts ?? [];
      toast.success('Cont adaugat.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function deleteAccount(id: string) {
    if (!confirm('Sterge contul?')) return;
    try { await api.delete(`/ext/compliance/ro/saft/accounts/${id}`); accounts = accounts.filter((a) => a.id !== id); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function createEntry() {
    if (!entryForm.account_code || !entryForm.description) return;
    creating = true;
    try {
      await api.post('/ext/compliance/ro/saft/entries', { ...entryForm, debit: Number(entryForm.debit), credit: Number(entryForm.credit) });
      showEntryModal = false;
      entryForm = { account_code: '', entry_date: new Date().toISOString().split('T')[0], description: '', debit: 0, credit: 0, document_number: '' };
      const r = await api.get<{ entries: any[] }>('/ext/compliance/ro/saft/entries');
      entries = r.entries ?? [];
      toast.success('Inregistrare adaugata.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function deleteEntry(id: string) {
    if (!confirm('Sterge inregistrarea?')) return;
    try { await api.delete(`/ext/compliance/ro/saft/entries/${id}`); entries = entries.filter((e) => e.id !== id); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  function statusBadge(status: string): string {
    return ({ draft: 'badge-warning', generated: 'badge-info', submitted: 'badge-success' } as Record<string, string>)[status] ?? 'badge-ghost';
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><FileSpreadsheet size={20} /> SAF-T RO</h1>
      <p class="text-sm text-base-content/50">Standard Audit File for Tax — generare D.394 XML pentru ANAF</p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={loadAll}><RefreshCw size={14} /></button>
      {#if activeTab === 'exports'}
        <button class="btn btn-primary btn-sm gap-1" onclick={() => (showCreateModal = true)}><Plus size={14} /> New Export</button>
      {:else if activeTab === 'accounts'}
        <button class="btn btn-primary btn-sm gap-1" onclick={() => (showAccountModal = true)}><Plus size={14} /> Add Account</button>
      {:else}
        <button class="btn btn-primary btn-sm gap-1" onclick={() => (showEntryModal = true)}><Plus size={14} /> Add Entry</button>
      {/if}
    </div>
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    {#each [['exports', 'Exports'], ['accounts', 'Accounts'], ['entries', 'Journal Entries']] as [tab, label]}
      <button class="tab {activeTab === tab ? 'tab-active' : ''}" onclick={() => (activeTab = tab as any)}>{label}</button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if activeTab === 'exports'}
    {#if exports_.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">No SAF-T exports yet.</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Period</th><th>Company</th><th>CUI</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {#each exports_ as exp (exp.id)}
              <tr class="hover">
                <td class="font-mono text-sm">{exp.period_start} → {exp.period_end}</td>
                <td class="text-sm">{exp.company_name}</td>
                <td class="font-mono text-xs">{exp.company_cui}</td>
                <td><span class="badge badge-sm {statusBadge(exp.status)}">{exp.status}</span></td>
                <td>
                  <div class="flex gap-1">
                    {#if exp.status === 'draft'}
                      <button class="btn btn-ghost btn-xs" onclick={() => generateXML(exp.id)}>XML</button>
                    {/if}
                    {#if exp.status !== 'draft'}
                      <button class="btn btn-ghost btn-xs" onclick={() => downloadXML(exp.id, exp.period_start, exp.period_end)}>
                        <Download size={12} />
                      </button>
                    {/if}
                    {#if exp.status === 'generated'}
                      <button class="btn btn-ghost btn-xs text-primary" onclick={() => submitToANAF(exp.id)}>
                        <Send size={12} />
                      </button>
                    {/if}
                    {#if exp.status === 'draft'}
                      <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteExport(exp.id)}>
                        <Trash2 size={12} />
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if activeTab === 'accounts'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Code</th><th>Description</th><th>Type</th><th></th></tr></thead>
        <tbody>
          {#if accounts.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No accounts defined.</td></tr>
          {:else}
            {#each accounts as acc (acc.id)}
              <tr class="hover">
                <td class="font-mono font-medium text-sm">{acc.code}</td>
                <td class="text-sm">{acc.description}</td>
                <td><span class="badge badge-sm badge-ghost">{acc.account_type}</span></td>
                <td><button class="btn btn-ghost btn-xs text-error" onclick={() => deleteAccount(acc.id)}><Trash2 size={12} /></button></td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>

  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Document</th><th class="text-right">Debit</th><th class="text-right">Credit</th><th></th></tr></thead>
        <tbody>
          {#if entries.length === 0}
            <tr><td colspan="7" class="text-center py-6 text-base-content/50 text-sm">No journal entries.</td></tr>
          {:else}
            {#each entries as entry (entry.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{entry.entry_date}</td>
                <td class="font-mono text-xs font-medium">{entry.account_code}</td>
                <td class="text-sm max-w-48 truncate">{entry.description}</td>
                <td class="font-mono text-xs text-base-content/50">{entry.document_number || '—'}</td>
                <td class="text-right font-mono text-xs">{Number(entry.debit).toFixed(2)}</td>
                <td class="text-right font-mono text-xs">{Number(entry.credit).toFixed(2)}</td>
                <td><button class="btn btn-ghost btn-xs text-error" onclick={() => deleteEntry(entry.id)}><Trash2 size={12} /></button></td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-4">New SAF-T Export</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="saft-start"><span class="label-text text-xs">Period start</span></label>
            <input id="saft-start" type="date" bind:value={exportForm.period_start} class="input input-sm" />
          </div>
          <div class="form-control">
            <label class="label" for="saft-end"><span class="label-text text-xs">Period end</span></label>
            <input id="saft-end" type="date" bind:value={exportForm.period_end} class="input input-sm" />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="saft-company"><span class="label-text text-xs">Company name</span></label>
          <input id="saft-company" type="text" bind:value={exportForm.company_name} placeholder="SC Example SRL" class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="saft-cui"><span class="label-text text-xs">CUI/CIF</span></label>
          <input id="saft-cui" type="text" bind:value={exportForm.company_cui} placeholder="RO12345678" class="input input-sm font-mono" />
        </div>
        <div class="form-control">
          <label class="label" for="saft-address"><span class="label-text text-xs">Address (optional)</span></label>
          <input id="saft-address" type="text" bind:value={exportForm.company_address} placeholder="Str. Exemplu nr. 1, București" class="input input-sm" />
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createExport} disabled={creating || !exportForm.company_name || !exportForm.company_cui}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if} Create Export
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}

{#if showAccountModal}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-lg mb-4">Add Account</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label" for="acc-code"><span class="label-text text-xs">Account code</span></label>
          <input id="acc-code" type="text" bind:value={accountForm.code} placeholder="101" class="input input-sm font-mono" />
        </div>
        <div class="form-control">
          <label class="label" for="acc-desc"><span class="label-text text-xs">Description</span></label>
          <input id="acc-desc" type="text" bind:value={accountForm.description} placeholder="Capital social" class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="acc-type"><span class="label-text text-xs">Type</span></label>
          <select id="acc-type" bind:value={accountForm.account_type} class="select select-sm">
            <option value="balance">Balance</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showAccountModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createAccount} disabled={creating || !accountForm.code || !accountForm.description}>Add</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showAccountModal = false)}></button>
  </dialog>
{/if}

{#if showEntryModal}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-4">Add Journal Entry</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="entry-date"><span class="label-text text-xs">Date</span></label>
            <input id="entry-date" type="date" bind:value={entryForm.entry_date} class="input input-sm" />
          </div>
          <div class="form-control">
            <label class="label" for="entry-account"><span class="label-text text-xs">Account code</span></label>
            <input id="entry-account" type="text" bind:value={entryForm.account_code} placeholder="101" class="input input-sm font-mono" />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="entry-desc"><span class="label-text text-xs">Description</span></label>
          <input id="entry-desc" type="text" bind:value={entryForm.description} placeholder="Entry description" class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="entry-doc"><span class="label-text text-xs">Document number (optional)</span></label>
          <input id="entry-doc" type="text" bind:value={entryForm.document_number} placeholder="FAC-2026-001" class="input input-sm font-mono" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="entry-debit"><span class="label-text text-xs">Debit (RON)</span></label>
            <input id="entry-debit" type="number" step="0.01" bind:value={entryForm.debit} class="input input-sm font-mono" />
          </div>
          <div class="form-control">
            <label class="label" for="entry-credit"><span class="label-text text-xs">Credit (RON)</span></label>
            <input id="entry-credit" type="number" step="0.01" bind:value={entryForm.credit} class="input input-sm font-mono" />
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showEntryModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createEntry} disabled={creating || !entryForm.account_code || !entryForm.description}>Add Entry</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showEntryModal = false)}></button>
  </dialog>
{/if}
