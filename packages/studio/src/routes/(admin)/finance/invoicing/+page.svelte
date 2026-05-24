<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { Plus, X, Trash2, LoaderCircle, Send, DollarSign } from '@lucide/svelte';

  type Invoice = {
    id: string; invoice_number: string; client_name: string; client_email: string | null;
    status: string; total: number; amount_paid: number; currency: string;
    due_date: string | null; issued_date: string; created_at: string;
  };
  type Stats = { total_invoiced: number; total_paid: number; total_overdue: number; count_draft: number };

  let invoices = $state<Invoice[]>([]);
  let stats = $state<Stats | null>(null);
  let loading = $state(true);
  let showModal = $state(false);
  let saving = $state(false);
  let actionId = $state<string | null>(null);
  let confirmDelete = $state<{ open: boolean; id: string }>({ open: false, id: '' });

  let form = $state({
    client_name: '', client_email: '', currency: 'RON',
    due_days: 30, notes: '',
    lines: [{ description: '', quantity: 1, unit_price: 0, tax_rate: 19 }],
  });

  const dash = $derived(m['common.emptyDash']());

  onMount(async () => {
    await Promise.all([loadInvoices(), loadStats()]);
  });

  async function loadInvoices() {
    loading = true;
    try {
      const r = await api.get<{ data: Invoice[] }>('/ext/finance/invoicing/invoices');
      invoices = r.data ?? [];
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
  }

  async function loadStats() {
    try {
      const r = await api.get<{ stats: Stats }>('/ext/finance/invoicing/invoices/stats');
      stats = r.stats;
    } catch { /* ignore */ }
  }

  function addLine() {
    form.lines = [...form.lines, { description: '', quantity: 1, unit_price: 0, tax_rate: 19 }];
  }

  function statusLabel(status: string): string {
    const key = `invoicing.status.${status}` as 'invoicing.status.draft';
    const fn = (m as Record<string, (() => string) | undefined>)[key];
    return fn?.() ?? status;
  }

  async function create() {
    saving = true;
    try {
      const r = await api.post<{ data: Invoice }>('/ext/finance/invoicing/invoices', form);
      invoices = [r.data, ...invoices];
      showModal = false;
      await loadStats();
      toast.success(m['invoicing.toast.created']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  async function sendInvoice(id: string) {
    actionId = id;
    try {
      await api.post(`/ext/finance/invoicing/invoices/${id}/send`, {});
      await loadInvoices();
      toast.success(m['invoicing.toast.sent']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      actionId = null;
    }
  }

  async function markPaid(id: string, total: number) {
    actionId = id;
    try {
      await api.post(`/ext/finance/invoicing/invoices/${id}/pay`, { amount: total });
      await loadInvoices();
      await loadStats();
      toast.success(m['invoicing.toast.paid']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      actionId = null;
    }
  }

  function requestDelete(id: string) {
    confirmDelete = { open: true, id };
  }

  async function confirmDeleteInvoice() {
    const id = confirmDelete.id;
    confirmDelete = { open: false, id: '' };
    actionId = id;
    try {
      await api.delete(`/ext/finance/invoicing/invoices/${id}`);
      invoices = invoices.filter((i) => i.id !== id);
      await loadStats();
      toast.success(m['invoicing.toast.deleted']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      actionId = null;
    }
  }

  const statusColor: Record<string, string> = {
    draft: 'badge-ghost', sent: 'badge-info', partial: 'badge-warning',
    paid: 'badge-success', overdue: 'badge-error', cancelled: 'badge-ghost',
  };
</script>

<ExtensionPageShell
  title={m['invoicing.title']()}
  subtitle={m['invoicing.subtitle']()}
>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['invoicing.newInvoice']()}
    </button>
  {/snippet}

  {#snippet children()}
    {#if stats}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="stat bg-base-200 rounded-xl py-3">
          <div class="stat-title text-xs">{m['invoicing.stat.invoiced']()}</div>
          <div class="stat-value text-lg">{stats.total_invoiced.toLocaleString()}</div>
        </div>
        <div class="stat bg-base-200 rounded-xl py-3">
          <div class="stat-title text-xs">{m['invoicing.stat.collected']()}</div>
          <div class="stat-value text-lg text-success">{stats.total_paid.toLocaleString()}</div>
        </div>
        <div class="stat bg-base-200 rounded-xl py-3">
          <div class="stat-title text-xs">{m['invoicing.stat.overdue']()}</div>
          <div class="stat-value text-lg text-error">{stats.total_overdue.toLocaleString()}</div>
        </div>
        <div class="stat bg-base-200 rounded-xl py-3">
          <div class="stat-title text-xs">{m['invoicing.stat.drafts']()}</div>
          <div class="stat-value text-lg">{stats.count_draft}</div>
        </div>
      </div>
    {/if}

    <ExtensionDataPanel
      {loading}
      empty={!loading && invoices.length === 0}
      emptyTitle={m['invoicing.empty']()}
    >
      {#snippet table()}
        <table class="table table-sm">
          <thead>
            <tr>
              <th>{m['invoicing.col.number']()}</th>
              <th>{m['invoicing.col.client']()}</th>
              <th>{m['invoicing.col.total']()}</th>
              <th>{m['invoicing.col.paid']()}</th>
              <th>{m['invoicing.col.status']()}</th>
              <th>{m['invoicing.col.dueDate']()}</th>
              <th>{m['common.actions']()}</th>
            </tr>
          </thead>
          <tbody>
            {#each invoices as inv (inv.id)}
              <tr class="hover">
                <td class="font-mono text-xs font-medium">{inv.invoice_number}</td>
                <td>
                  <div class="text-sm font-medium">{inv.client_name}</div>
                  {#if inv.client_email}<div class="text-xs text-base-content/50">{inv.client_email}</div>{/if}
                </td>
                <td class="font-medium">{inv.total.toLocaleString()} {inv.currency}</td>
                <td class="text-success">
                  {inv.amount_paid > 0 ? `${inv.amount_paid.toLocaleString()} ${inv.currency}` : dash}
                </td>
                <td>
                  <span class="badge badge-sm {statusColor[inv.status] ?? 'badge-ghost'}">
                    {statusLabel(inv.status)}
                  </span>
                </td>
                <td class="text-xs {inv.status === 'overdue' ? 'text-error font-medium' : 'text-base-content/50'}">
                  {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : dash}
                </td>
                <td>
                  <div class="flex items-center gap-1">
                    {#if inv.status === 'draft'}
                      <button
                        type="button"
                        class="btn btn-xs btn-ghost"
                        title={m['invoicing.action.send']()}
                        disabled={actionId === inv.id}
                        onclick={() => sendInvoice(inv.id)}
                      ><Send size={11} /></button>
                    {/if}
                    {#if inv.status === 'sent' || inv.status === 'partial' || inv.status === 'overdue'}
                      <button
                        type="button"
                        class="btn btn-xs btn-success btn-ghost"
                        title={m['invoicing.action.markPaid']()}
                        disabled={actionId === inv.id}
                        onclick={() => markPaid(inv.id, inv.total - inv.amount_paid)}
                      ><DollarSign size={11} /></button>
                    {/if}
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs text-error"
                      disabled={actionId === inv.id}
                      onclick={() => requestDelete(inv.id)}
                    >
                      {#if actionId === inv.id}<LoaderCircle size={11} class="animate-spin" />{:else}<Trash2 size={11} />{/if}
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </ExtensionDataPanel>
  {/snippet}
</ExtensionPageShell>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['invoicing.form.newInvoice']()}</h3>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
      </div>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.clientName']()} *</span></label>
            <input class="input input-sm" bind:value={form.client_name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.clientEmail']()}</span></label>
            <input class="input input-sm" type="email" bind:value={form.client_email} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
            <select class="select select-sm" bind:value={form.currency}>
              <option>RON</option><option>EUR</option><option>USD</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.dueDays']()}</span></label>
            <input class="input input-sm" type="number" bind:value={form.due_days} />
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium">{m['invoicing.form.lines']()}</span>
            <button type="button" class="btn btn-xs btn-ghost gap-1" onclick={addLine}>
              <Plus size={11} /> {m['invoicing.form.addLine']()}
            </button>
          </div>
          <div class="space-y-2">
            {#each form.lines as line, i (i)}
              <div class="grid grid-cols-12 gap-1.5 items-end">
                <div class="col-span-5 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.description']()}</span></label>{/if}
                  <input class="input input-xs" bind:value={line.description} />
                </div>
                <div class="col-span-2 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.qty']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.quantity} />
                </div>
                <div class="col-span-3 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.unitPrice']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.unit_price} />
                </div>
                <div class="col-span-1 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.taxPercent']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.tax_rate} />
                </div>
                <div class="col-span-1 flex items-end pb-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs text-error"
                    onclick={() => { form.lines = form.lines.filter((_, j) => j !== i); }}
                    disabled={form.lines.length === 1}
                  ><X size={11} /></button>
                </div>
              </div>
            {/each}
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
        <button
          type="button"
          class="btn btn-primary btn-sm gap-1"
          onclick={create}
          disabled={!form.client_name.trim() || saving}
        >
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}

<ConfirmModal
  open={confirmDelete.open}
  title={m['common.delete']()}
  message={m['invoicing.deleteConfirm']()}
  confirmLabel={m['common.delete']()}
  onconfirm={confirmDeleteInvoice}
  oncancel={() => (confirmDelete = { open: false, id: '' })}
/>
