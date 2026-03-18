<script lang="ts">
  import { onMount } from 'svelte';
  import { Plus, Download, Send, Trash2, FileSpreadsheet, RefreshCw } from '@lucide/svelte';

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

  let activeTab = $state<'exports' | 'accounts' | 'entries'>('exports');
  function setTab(t: string) { activeTab = t as 'exports' | 'accounts' | 'entries'; }
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

  onMount(() => loadAll());

  async function loadAll() {
    loading = true;
    await Promise.all([loadExports(), loadAccounts(), loadEntries()]);
    loading = false;
  }

  async function loadExports() {
    const res = await fetch(`${engineUrl}/api/saft`, { credentials: 'include' });
    const data = await res.json();
    exports_ = data.exports || [];
  }

  async function loadAccounts() {
    const res = await fetch(`${engineUrl}/api/saft/accounts`, { credentials: 'include' });
    const data = await res.json();
    accounts = data.accounts || [];
  }

  async function loadEntries() {
    const res = await fetch(`${engineUrl}/api/saft/entries`, { credentials: 'include' });
    const data = await res.json();
    entries = data.entries || [];
  }

  async function createExport() {
    if (!exportForm.company_name || !exportForm.company_cui) return;
    creating = true;
    try {
      const res = await fetch(`${engineUrl}/api/saft`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exportForm),
      });
      if (!res.ok) throw new Error('Failed');
      showCreateModal = false;
      await loadExports();
    } finally {
      creating = false;
    }
  }

  async function generateXML(id: string) {
    const res = await fetch(`${engineUrl}/api/saft/${id}/generate`, {
      method: 'POST',
      credentials: 'include',
    });
    if (res.ok) {
      alert('SAF-T XML generated successfully!');
      await loadExports();
    } else {
      const d = await res.json();
      alert(d.error || 'Failed to generate XML');
    }
  }

  async function downloadXML(id: string, start: string, end: string) {
    const res = await fetch(`${engineUrl}/api/saft/${id}/xml`, { credentials: 'include' });
    if (!res.ok) { alert('Generate XML first'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SAFT_${start}_${end}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function submitToANAF(id: string) {
    if (!confirm('Submit this SAF-T export to ANAF?')) return;
    const res = await fetch(`${engineUrl}/api/saft/${id}/submit`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json();
    if (res.ok) {
      alert('Submitted to ANAF!');
      await loadExports();
    } else {
      alert(data.error || 'Submission failed');
    }
  }

  async function deleteExport(id: string) {
    if (!confirm('Delete this export?')) return;
    await fetch(`${engineUrl}/api/saft/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadExports();
  }

  async function createAccount() {
    if (!accountForm.code || !accountForm.description) return;
    creating = true;
    try {
      await fetch(`${engineUrl}/api/saft/accounts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountForm),
      });
      showAccountModal = false;
      accountForm = { code: '', description: '', account_type: 'balance' };
      await loadAccounts();
    } finally {
      creating = false;
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm('Delete this account?')) return;
    await fetch(`${engineUrl}/api/saft/accounts/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadAccounts();
  }

  async function createEntry() {
    if (!entryForm.account_code || !entryForm.description) return;
    creating = true;
    try {
      await fetch(`${engineUrl}/api/saft/entries`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...entryForm, debit: Number(entryForm.debit), credit: Number(entryForm.credit) }),
      });
      showEntryModal = false;
      entryForm = { account_code: '', entry_date: new Date().toISOString().split('T')[0], description: '', debit: 0, credit: 0, document_number: '' };
      await loadEntries();
    } finally {
      creating = false;
    }
  }

  async function deleteEntry(id: string) {
    if (!confirm('Delete this entry?')) return;
    await fetch(`${engineUrl}/api/saft/entries/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadEntries();
  }

  function statusBadge(status: string): string {
    return { draft: 'badge-warning', generated: 'badge-info', submitted: 'badge-success' }[status] || 'badge-ghost';
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">SAF-T RO</h1>
      <p class="text-base-content/60 text-sm mt-1">Standard Audit File for Tax — generate D.394 XML for ANAF</p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={loadAll}><RefreshCw size={14} /></button>
      {#if activeTab === 'exports'}
        <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
          <Plus size={16} /> New Export
        </button>
      {:else if activeTab === 'accounts'}
        <button class="btn btn-primary btn-sm gap-2" onclick={() => (showAccountModal = true)}>
          <Plus size={16} /> Add Account
        </button>
      {:else}
        <button class="btn btn-primary btn-sm gap-2" onclick={() => (showEntryModal = true)}>
          <Plus size={16} /> Add Entry
        </button>
      {/if}
    </div>
  </div>

  <div class="tabs tabs-boxed w-fit">
    {#each [['exports', 'Exports'], ['accounts', 'Accounts'], ['entries', 'Journal Entries']] as [tab, label]}
      <button class="tab {activeTab === tab ? 'tab-active' : ''}" onclick={() => setTab(tab)}>{label}</button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if activeTab === 'exports'}
    {#if exports_.length === 0}
      <div class="card bg-base-200 text-center py-12">
        <FileSpreadsheet size={48} class="mx-auto text-base-content/20 mb-3" />
        <p class="text-base-content/60">No SAF-T exports yet</p>
        <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>Create Export</button>
      </div>
    {:else}
      <div class="card bg-base-200">
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead><tr><th>Period</th><th>Company</th><th>CUI</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {#each exports_ as exp}
                <tr>
                  <td class="font-mono text-sm">{exp.period_start} → {exp.period_end}</td>
                  <td>{exp.company_name}</td>
                  <td class="font-mono text-xs">{exp.company_cui}</td>
                  <td><span class="badge badge-sm {statusBadge(exp.status)}">{exp.status}</span></td>
                  <td>
                    <div class="flex gap-1">
                      {#if exp.status === 'draft'}
                        <button class="btn btn-ghost btn-xs" onclick={() => generateXML(exp.id)} title="Generate XML">XML</button>
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
      </div>
    {/if}
  {:else if activeTab === 'accounts'}
    <div class="card bg-base-200">
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Code</th><th>Description</th><th>Type</th><th></th></tr></thead>
          <tbody>
            {#if accounts.length === 0}
              <tr><td colspan="4" class="text-center text-base-content/40 py-8">No accounts defined</td></tr>
            {/if}
            {#each accounts as acc}
              <tr>
                <td class="font-mono font-medium">{acc.code}</td>
                <td>{acc.description}</td>
                <td><span class="badge badge-sm badge-ghost">{acc.account_type}</span></td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteAccount(acc.id)}>
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {:else}
    <div class="card bg-base-200">
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Date</th><th>Account</th><th>Description</th><th>Document</th><th class="text-right">Debit</th><th class="text-right">Credit</th><th></th></tr></thead>
          <tbody>
            {#if entries.length === 0}
              <tr><td colspan="7" class="text-center text-base-content/40 py-8">No journal entries</td></tr>
            {/if}
            {#each entries as entry}
              <tr>
                <td class="font-mono text-xs">{entry.entry_date}</td>
                <td class="font-mono text-xs font-medium">{entry.account_code}</td>
                <td class="max-w-48 truncate">{entry.description}</td>
                <td class="font-mono text-xs text-base-content/50">{entry.document_number || '—'}</td>
                <td class="text-right font-mono text-xs">{Number(entry.debit).toFixed(2)}</td>
                <td class="text-right font-mono text-xs">{Number(entry.credit).toFixed(2)}</td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteEntry(entry.id)}>
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<!-- Create Export Modal -->
{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-4">New SAF-T Export</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="saft-period-start"><span class="label-text text-xs">Period start</span></label>
            <input id="saft-period-start" type="date" bind:value={exportForm.period_start} class="input input-sm" />
          </div>
          <div class="form-control">
            <label class="label" for="saft-period-end"><span class="label-text text-xs">Period end</span></label>
            <input id="saft-period-end" type="date" bind:value={exportForm.period_end} class="input input-sm" />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="saft-company-name"><span class="label-text text-xs">Company name</span></label>
          <input id="saft-company-name" type="text" bind:value={exportForm.company_name} placeholder="SC Example SRL" class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="saft-company-cui"><span class="label-text text-xs">CUI/CIF</span></label>
          <input id="saft-company-cui" type="text" bind:value={exportForm.company_cui} placeholder="RO12345678" class="input input-sm font-mono" />
        </div>
        <div class="form-control">
          <label class="label" for="saft-company-address"><span class="label-text text-xs">Address (optional)</span></label>
          <input id="saft-company-address" type="text" bind:value={exportForm.company_address} placeholder="Str. Exemplu nr. 1, București" class="input input-sm" />
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createExport} disabled={creating}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          Create Export
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}

<!-- Add Account Modal -->
{#if showAccountModal}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-lg mb-4">Add Account</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label" for="account-code"><span class="label-text text-xs">Account code</span></label>
          <input id="account-code" type="text" bind:value={accountForm.code} placeholder="101" class="input input-sm font-mono" />
        </div>
        <div class="form-control">
          <label class="label" for="account-description"><span class="label-text text-xs">Description</span></label>
          <input id="account-description" type="text" bind:value={accountForm.description} placeholder="Capital social" class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="account-type"><span class="label-text text-xs">Type</span></label>
          <select id="account-type" bind:value={accountForm.account_type} class="select select-sm">
            <option value="balance">Balance</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showAccountModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createAccount} disabled={creating}>Add</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showAccountModal = false)}></button>
  </dialog>
{/if}

<!-- Add Journal Entry Modal -->
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
            <label class="label" for="entry-account-code"><span class="label-text text-xs">Account code</span></label>
            <input id="entry-account-code" type="text" bind:value={entryForm.account_code} placeholder="101" class="input input-sm font-mono" />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="entry-description"><span class="label-text text-xs">Description</span></label>
          <input id="entry-description" type="text" bind:value={entryForm.description} placeholder="Entry description" class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="entry-document-number"><span class="label-text text-xs">Document number (optional)</span></label>
          <input id="entry-document-number" type="text" bind:value={entryForm.document_number} placeholder="FAC-2026-001" class="input input-sm font-mono" />
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
        <button class="btn btn-primary" onclick={createEntry} disabled={creating}>Add Entry</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showEntryModal = false)}></button>
  </dialog>
{/if}
