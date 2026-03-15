<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let transactions = $state<any[]>([]);
  let total = $state(0);
  let page = $state(1);
  let filterType = $state('');
  let filterStatus = $state('');
  let loading = $state(false);
  let showModal = $state(false);
  let editingTx = $state<any>(null);

  let form = $state({
    type: 'invoice',
    status: 'draft',
    number: '',
    currency: 'RON',
    amount: 0,
    tax_amount: 0,
    total_amount: 0,
    due_date: '',
    notes: '',
  });

  const TYPES = ['invoice', 'payment', 'credit_note', 'expense', 'transfer', 'other'];
  const STATUSES = ['draft', 'pending', 'completed', 'cancelled', 'refunded'];

  const STATUS_BADGE: Record<string, string> = {
    draft: 'badge-ghost',
    pending: 'badge-warning',
    completed: 'badge-success',
    cancelled: 'badge-error',
    refunded: 'badge-info',
  };

  async function loadTransactions() {
    loading = true;
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (filterType) params.set('type', filterType);
      if (filterStatus) params.set('status', filterStatus);
      const res = await api.get(`/transactions?${params}`);
      transactions = res.data;
      total = res.meta.total;
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editingTx = null;
    form = { type: 'invoice', status: 'draft', number: '', currency: 'RON', amount: 0, tax_amount: 0, total_amount: 0, due_date: '', notes: '' };
    showModal = true;
  }

  function openEdit(tx: any) {
    editingTx = tx;
    form = {
      type: tx.type,
      status: tx.status,
      number: tx.number ?? '',
      currency: tx.currency ?? 'RON',
      amount: tx.amount ?? 0,
      tax_amount: tx.tax_amount ?? 0,
      total_amount: tx.total_amount ?? 0,
      due_date: tx.due_date ?? '',
      notes: tx.notes ?? '',
    };
    showModal = true;
  }

  async function save() {
    const payload = { ...form, amount: Number(form.amount), tax_amount: Number(form.tax_amount), total_amount: Number(form.total_amount) };
    if (editingTx) {
      await api.patch(`/transactions/${editingTx.id}`, payload);
    } else {
      await api.post('/transactions', payload);
    }
    showModal = false;
    await loadTransactions();
  }

  async function deleteTx(id: string) {
    if (!confirm('Delete this transaction?')) return;
    await api.delete(`/transactions/${id}`);
    await loadTransactions();
  }

  function formatCurrency(amount: number, currency: string) {
    return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: currency || 'RON' }).format(amount);
  }

  onMount(loadTransactions);
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Transactions</h1>
      <p class="text-base-content/60">{total} transactions</p>
    </div>
    <button class="btn btn-primary" onclick={openCreate}>+ New Transaction</button>
  </div>

  <div class="flex gap-3">
    <select class="select select-bordered select-sm" bind:value={filterType} onchange={() => { page = 1; loadTransactions(); }}>
      <option value="">All types</option>
      {#each TYPES as t}<option value={t}>{t}</option>{/each}
    </select>
    <select class="select select-bordered select-sm" bind:value={filterStatus} onchange={() => { page = 1; loadTransactions(); }}>
      <option value="">All statuses</option>
      {#each STATUSES as s}<option value={s}>{s}</option>{/each}
    </select>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th>Number</th>
            <th>Type</th>
            <th>Status</th>
            <th>Amount</th>
            <th>Due Date</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each transactions as tx}
            <tr>
              <td class="font-mono text-sm">{tx.number ?? tx.id.slice(0, 8)}</td>
              <td><span class="badge badge-ghost">{tx.type}</span></td>
              <td><span class="badge {STATUS_BADGE[tx.status] ?? 'badge-ghost'} badge-sm">{tx.status}</span></td>
              <td class="font-medium">{formatCurrency(tx.total_amount ?? tx.amount ?? 0, tx.currency)}</td>
              <td>{tx.due_date ? new Date(tx.due_date).toLocaleDateString('ro-RO') : '—'}</td>
              <td class="text-right space-x-2">
                <button class="btn btn-ghost btn-xs" onclick={() => openEdit(tx)}>Edit</button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteTx(tx.id)}>Delete</button>
              </td>
            </tr>
          {/each}
          {#if !transactions.length}
            <tr><td colspan="6" class="text-center text-base-content/40 py-8">No transactions found</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    <div class="flex justify-center gap-2 mt-4">
      <button class="btn btn-sm" disabled={page === 1} onclick={() => { page--; loadTransactions(); }}>Prev</button>
      <span class="btn btn-sm btn-disabled">Page {page}</span>
      <button class="btn btn-sm" disabled={page * 20 >= total} onclick={() => { page++; loadTransactions(); }}>Next</button>
    </div>
  {/if}
</div>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">{editingTx ? 'Edit Transaction' : 'New Transaction'}</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label"><span class="label-text">Type *</span></label>
            <select class="select select-bordered" bind:value={form.type}>
              {#each TYPES as t}<option value={t}>{t}</option>{/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Status</span></label>
            <select class="select select-bordered" bind:value={form.status}>
              {#each STATUSES as s}<option value={s}>{s}</option>{/each}
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label"><span class="label-text">Number</span></label>
            <input class="input input-bordered" bind:value={form.number} placeholder="e.g. INV-2024-001" />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Currency</span></label>
            <input class="input input-bordered" bind:value={form.currency} />
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div class="form-control">
            <label class="label"><span class="label-text">Amount</span></label>
            <input type="number" class="input input-bordered" bind:value={form.amount} step="0.01" />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Tax</span></label>
            <input type="number" class="input input-bordered" bind:value={form.tax_amount} step="0.01" />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Total</span></label>
            <input type="number" class="input input-bordered" bind:value={form.total_amount} step="0.01" />
          </div>
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">Due Date</span></label>
          <input type="date" class="input input-bordered" bind:value={form.due_date} />
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">Notes</span></label>
          <textarea class="textarea textarea-bordered" bind:value={form.notes}></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn" onclick={() => showModal = false}>Cancel</button>
        <button class="btn btn-primary" onclick={save}>Save</button>
      </div>
    </div>
    <div class="modal-backdrop" onclick={() => showModal = false}></div>
  </div>
{/if}
