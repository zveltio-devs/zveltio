<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let transactions = $state<any[]>([]);
let total = $state(0);
let page = $state(1);
let filterType = $state('');
let filterStatus = $state('');
let loading = $state(false);
let showModal = $state(false);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  form = {
    type: 'invoice',
    status: 'draft',
    number: '',
    currency: 'RON',
    amount: 0,
    tax_amount: 0,
    total_amount: 0,
    due_date: '',
    notes: '',
  };
  showModal = true;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  const payload = {
    ...form,
    amount: Number(form.amount),
    tax_amount: Number(form.tax_amount),
    total_amount: Number(form.total_amount),
  };
  if (editingTx) {
    await api.patch(`/transactions/${editingTx.id}`, payload);
  } else {
    await api.post('/transactions', payload);
  }
  showModal = false;
  await loadTransactions();
}

async function deleteTx(id: string) {
  askConfirm(m['crm.transactions.confirmDelete'](), () => deleteTxConfirmed(id));
}
async function deleteTxConfirmed(id: string) {
  await api.delete(`/transactions/${id}`);
  await loadTransactions();
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: currency || 'RON' }).format(
    amount,
  );
}

onMount(loadTransactions);
</script>

<ExtensionPageShell title={m['crm.transactions.title']()} subtitle={m['crm.transactions.count']({ count: total })}>
  {#snippet actions()}
    <button class="btn btn-primary" onclick={openCreate}>{m['crm.ui.new_transaction']()}</button>
  {/snippet}
    <div class="space-y-6">
      <div class="flex gap-3">
        <select class="select select-bordered select-sm" bind:value={filterType} onchange={() => { page = 1; loadTransactions(); }}>
          <option value="">{m['crm.ui.filter.allTypes']()}</option>
          {#each TYPES as t}<option value={t}>{t}</option>{/each}
        </select>
        <select class="select select-bordered select-sm" bind:value={filterStatus} onchange={() => { page = 1; loadTransactions(); }}>
          <option value="">{m['crm.ui.filter.allStatuses']()}</option>
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
                <th>{m['invoicing.col.number']()}</th>
                <th>{m['common.col.type']()}</th>
                <th>{m['common.col.status']()}</th>
                <th>{m['common.col.amount']()}</th>
                <th>{m['crm.ui.due_date']()}</th>
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
                    <button class="btn btn-ghost btn-xs" onclick={() => openEdit(tx)}>{m['common.edit']()}</button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteTx(tx.id)}>{m['common.delete']()}</button>
                  </td>
                </tr>
              {/each}
              {#if !transactions.length}
                <tr><td colspan="6" class="text-center text-base-content/40 py-8">{m['crm.ui.no_transactions_found']()}</td></tr>
              {/if}
            </tbody>
          </table>
        </div>

        <div class="flex justify-center gap-2 mt-4">
          <button class="btn btn-sm" disabled={page === 1} onclick={() => { page--; loadTransactions(); }}>{m['common.prev']()}</button>
          <span class="btn btn-sm btn-disabled">{m['common.pageOf']({ page: String(page), total: String(Math.ceil(total / 20) || 1) })}</span>
          <button class="btn btn-sm" disabled={page * 20 >= total} onclick={() => { page++; loadTransactions(); }}>{m['common.next']()}</button>
        </div>
      {/if}
    </div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">{editingTx ? m['crm.ui.editTransaction']() : m['crm.ui.newTransactionTitle']()}</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="tx-type"><span class="label-text">{m['common.col.type']()}</span></label>
            <select id="tx-type" class="select select-bordered" bind:value={form.type}>
              {#each TYPES as t}<option value={t}>{t}</option>{/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label" for="tx-status"><span class="label-text">{m['common.col.status']()}</span></label>
            <select id="tx-status" class="select select-bordered" bind:value={form.status}>
              {#each STATUSES as s}<option value={s}>{s}</option>{/each}
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="tx-number"><span class="label-text">{m['invoicing.col.number']()}</span></label>
            <input id="tx-number" class="input input-bordered" bind:value={form.number} placeholder={m['crm.ui.e_g_inv_2024_001']()} />
          </div>
          <div class="form-control">
            <label class="label" for="tx-currency"><span class="label-text">{m['crm.form.currency']()}</span></label>
            <input id="tx-currency" class="input input-bordered" bind:value={form.currency} />
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div class="form-control">
            <label class="label" for="tx-amount"><span class="label-text">{m['common.col.amount']()}</span></label>
            <input id="tx-amount" type="number" class="input input-bordered" bind:value={form.amount} step="0.01" />
          </div>
          <div class="form-control">
            <label class="label" for="tx-tax"><span class="label-text">{m['crm.ui.tax']()}</span></label>
            <input id="tx-tax" type="number" class="input input-bordered" bind:value={form.tax_amount} step="0.01" />
          </div>
          <div class="form-control">
            <label class="label" for="tx-total"><span class="label-text">{m['common.col.total']()}</span></label>
            <input id="tx-total" type="number" class="input input-bordered" bind:value={form.total_amount} step="0.01" />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="tx-due-date"><span class="label-text">{m['crm.ui.due_date']()}</span></label>
          <input id="tx-due-date" type="date" class="input input-bordered" bind:value={form.due_date} />
        </div>
        <div class="form-control">
          <label class="label" for="tx-notes"><span class="label-text">{m['common.col.notes']()}</span></label>
          <textarea id="tx-notes" class="textarea textarea-bordered" bind:value={form.notes}></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn" onclick={() => showModal = false}>{m['common.cancel']()}</button>
        <button class="btn btn-primary" onclick={save}>{m['common.save']()}</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label={m['common.close']()} onclick={() => showModal = false}></button>
  </div>
{/if}
