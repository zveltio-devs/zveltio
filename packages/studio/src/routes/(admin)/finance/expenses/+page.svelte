<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Receipt, Plus, X, Check, LoaderCircle } from '@lucide/svelte';

  let expenses = $state<any[]>([]);
  let loading = $state(true);
  let statusFilter = $state<'all' | 'draft' | 'submitted' | 'approved' | 'reimbursed'>('all');
  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    expense_date: new Date().toISOString().slice(0, 10),
    category: 'travel', description: '', amount: 0, currency: 'RON', vendor: '', receipt_url: '',
  });

  async function load() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const r = await api.get<{ data: any[] }>(`/api/expenses?${params}`);
      expenses = r.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function createExpense() {
    saving = true;
    try {
      await api.post('/api/expenses', form);
      showForm = false;
      form = { expense_date: new Date().toISOString().slice(0, 10), category: 'travel', description: '', amount: 0, currency: 'RON', vendor: '', receipt_url: '' };
      await load();
      toast.success('Expense submitted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function approve(id: string) {
    try {
      await api.post(`/api/expenses/${id}/approve`, {});
      await load();
      toast.success('Approved.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => { statusFilter; load(); });

  function statusBadge(s: string) {
    return ({ draft: 'badge-ghost', submitted: 'badge-warning', approved: 'badge-success', reimbursed: 'badge-info', rejected: 'badge-error' } as any)[s] ?? 'badge-ghost';
  }
  function fmt(n: number, c = 'RON') { return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: c }).format(n); }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Receipt size={20} /> Expenses</h1>
      <p class="text-sm text-base-content/50">Track and approve employee expenses</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New expense</button>
  </div>

  <select bind:value={statusFilter} class="select select-sm max-w-xs">
    <option value="all">All statuses</option>
    <option value="draft">Draft</option>
    <option value="submitted">Submitted</option>
    <option value="approved">Approved</option>
    <option value="reimbursed">Reimbursed</option>
  </select>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th>Description</th><th class="text-right">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#if expenses.length === 0}
            <tr><td colspan="7" class="text-center py-6 text-base-content/50 text-sm">No expenses.</td></tr>
          {:else}
            {#each expenses as e (e.id)}
              <tr class="hover">
                <td class="text-xs">{e.expense_date}</td>
                <td><span class="badge badge-ghost badge-sm">{e.category}</span></td>
                <td class="text-sm">{e.vendor ?? '—'}</td>
                <td class="max-w-xs truncate text-sm">{e.description}</td>
                <td class="text-right text-sm">{fmt(Number(e.amount), e.currency)}</td>
                <td><span class="badge {statusBadge(e.status)} badge-sm">{e.status}</span></td>
                <td>{#if e.status === 'submitted'}<button class="btn btn-ghost btn-xs" title="Approve" onclick={() => approve(e.id)}><Check size={13} /></button>{/if}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New expense</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Date</span></label><input type="date" class="input input-sm" bind:value={form.expense_date} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Category</span></label>
          <select class="select select-sm" bind:value={form.category}>
            <option value="travel">Travel</option><option value="meals">Meals</option>
            <option value="office">Office</option><option value="software">Software</option><option value="other">Other</option>
          </select>
        </div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Vendor</span></label><input class="input input-sm" bind:value={form.vendor} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Description *</span></label><input class="input input-sm" bind:value={form.description} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Amount</span></label><input type="number" step="0.01" class="input input-sm" bind:value={form.amount} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label><input class="input input-sm" bind:value={form.currency} maxlength={3} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Receipt URL (optional)</span></label><input class="input input-sm" bind:value={form.receipt_url} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.description || form.amount <= 0} onclick={createExpense}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Submit
        </button>
      </div>
    </div>
  </div>
{/if}
