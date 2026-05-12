<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, X, Trash2, LoaderCircle, FileText, Send, DollarSign, AlertCircle } from '@lucide/svelte';

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

  let form = $state({
    client_name: '', client_email: '', currency: 'RON',
    due_days: 30, notes: '',
    lines: [{ description: '', quantity: 1, unit_price: 0, tax_rate: 19 }],
  });

  onMount(async () => {
    await Promise.all([loadInvoices(), loadStats()]);
  });

  async function loadInvoices() {
    loading = true;
    try {
      const r = await api.get<{ data: Invoice[] }>('/api/invoicing/invoices');
      invoices = r.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function loadStats() {
    try {
      const r = await api.get<{ stats: Stats }>('/api/invoicing/invoices/stats');
      stats = r.stats;
    } catch { /* ignore */ }
  }

  function addLine() {
    form.lines = [...form.lines, { description: '', quantity: 1, unit_price: 0, tax_rate: 19 }];
  }

  async function create() {
    saving = true;
    try {
      const r = await api.post<{ data: Invoice }>('/api/invoicing/invoices', form);
      invoices = [r.data, ...invoices];
      showModal = false;
      toast.success('Invoice created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function sendInvoice(id: string) {
    actionId = id;
    try {
      await api.post(`/api/invoicing/invoices/${id}/send`, {});
      await loadInvoices();
      toast.success('Invoice sent.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { actionId = null; }
  }

  async function markPaid(id: string, total: number) {
    actionId = id;
    try {
      await api.post(`/api/invoicing/invoices/${id}/pay`, { amount: total });
      await loadInvoices();
      toast.success('Invoice marked as paid.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { actionId = null; }
  }

  async function deleteInvoice(id: string) {
    if (!confirm('Delete this invoice?')) return;
    actionId = id;
    try {
      await api.delete(`/api/invoicing/invoices/${id}`);
      invoices = invoices.filter(i => i.id !== id);
      toast.success('Deleted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { actionId = null; }
  }

  const statusColor: Record<string, string> = {
    draft: 'badge-ghost', sent: 'badge-info', partial: 'badge-warning',
    paid: 'badge-success', overdue: 'badge-error', cancelled: 'badge-ghost',
  };
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Invoicing</h1>
      <p class="text-sm text-base-content/50">Create and manage invoices and payments</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={14} /> New Invoice
    </button>
  </div>

  {#if stats}
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Total Invoiced</div>
        <div class="stat-value text-lg">{stats.total_invoiced.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Collected</div>
        <div class="stat-value text-lg text-success">{stats.total_paid.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Overdue</div>
        <div class="stat-value text-lg text-error">{stats.total_overdue.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Drafts</div>
        <div class="stat-value text-lg">{stats.count_draft}</div>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if invoices.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-16 gap-3">
        <FileText size={36} class="text-base-content/20" />
        <p class="text-sm text-base-content/50">No invoices yet.</p>
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Number</th><th>Client</th><th>Total</th><th>Paid</th><th>Status</th><th>Due Date</th><th>Actions</th></tr></thead>
        <tbody>
          {#each invoices as inv (inv.id)}
            <tr class="hover">
              <td class="font-mono text-xs font-medium">{inv.invoice_number}</td>
              <td>
                <div class="text-sm font-medium">{inv.client_name}</div>
                {#if inv.client_email}<div class="text-xs text-base-content/50">{inv.client_email}</div>{/if}
              </td>
              <td class="font-medium">{inv.total.toLocaleString()} {inv.currency}</td>
              <td class="text-success">{inv.amount_paid > 0 ? `${inv.amount_paid.toLocaleString()} ${inv.currency}` : '—'}</td>
              <td><span class="badge badge-sm {statusColor[inv.status] ?? 'badge-ghost'}">{inv.status}</span></td>
              <td class="text-xs {inv.status === 'overdue' ? 'text-error font-medium' : 'text-base-content/50'}">
                {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : '—'}
              </td>
              <td>
                <div class="flex items-center gap-1">
                  {#if inv.status === 'draft'}
                    <button class="btn btn-xs btn-ghost" title="Send" disabled={actionId === inv.id}
                      onclick={() => sendInvoice(inv.id)}><Send size={11} /></button>
                  {/if}
                  {#if inv.status === 'sent' || inv.status === 'partial' || inv.status === 'overdue'}
                    <button class="btn btn-xs btn-success btn-ghost" title="Mark paid" disabled={actionId === inv.id}
                      onclick={() => markPaid(inv.id, inv.total - inv.amount_paid)}>
                      <DollarSign size={11} />
                    </button>
                  {/if}
                  <button class="btn btn-ghost btn-xs text-error" disabled={actionId === inv.id}
                    onclick={() => deleteInvoice(inv.id)}>
                    {#if actionId === inv.id}<LoaderCircle size={11} class="animate-spin" />{:else}<Trash2 size={11} />{/if}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New Invoice</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
      </div>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Client Name *</span></label>
            <input class="input input-sm" bind:value={form.client_name} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Client Email</span></label>
            <input class="input input-sm" type="email" bind:value={form.client_email} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label>
            <select class="select select-sm" bind:value={form.currency}>
              <option>RON</option><option>EUR</option><option>USD</option>
            </select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Due in (days)</span></label>
            <input class="input input-sm" type="number" bind:value={form.due_days} /></div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium">Lines</span>
            <button class="btn btn-xs btn-ghost gap-1" onclick={addLine}><Plus size={11} /> Add line</button>
          </div>
          <div class="space-y-2">
            {#each form.lines as line, i (i)}
              <div class="grid grid-cols-12 gap-1.5 items-end">
                <div class="col-span-5 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">Description</span></label>{/if}
                  <input class="input input-xs" bind:value={line.description} />
                </div>
                <div class="col-span-2 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">Qty</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.quantity} />
                </div>
                <div class="col-span-3 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">Unit Price</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.unit_price} />
                </div>
                <div class="col-span-1 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">Tax%</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.tax_rate} />
                </div>
                <div class="col-span-1 flex items-end pb-0.5">
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => { form.lines = form.lines.filter((_, j) => j !== i); }} disabled={form.lines.length === 1}>
                    <X size={11} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm gap-1" onclick={create} disabled={!form.client_name.trim() || saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}Create Invoice
        </button>
      </div>
    </div>
  </div>
{/if}
