<script lang="ts">
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { Plus, X, Check, LoaderCircle } from '@lucide/svelte';

  type Expense = {
    id: string;
    expense_date: string;
    category: string;
    vendor?: string | null;
    description: string;
    amount: number;
    currency: string;
    status: string;
  };

  let expenses = $state<Expense[]>([]);
  let loading = $state(true);
  let statusFilter = $state<'all' | 'draft' | 'submitted' | 'approved' | 'reimbursed'>('all');
  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    expense_date: new Date().toISOString().slice(0, 10),
    category: 'travel', description: '', amount: 0, currency: 'RON', vendor: '', receipt_url: '',
  });

  const dash = $derived(m['common.emptyDash']());

  const statusOptions = $derived([
    { value: 'all' as const, label: m['finance.expenses.filter.all']() },
    { value: 'draft' as const, label: m['finance.expenses.filter.draft']() },
    { value: 'submitted' as const, label: m['finance.expenses.filter.submitted']() },
    { value: 'approved' as const, label: m['finance.expenses.filter.approved']() },
    { value: 'reimbursed' as const, label: m['finance.expenses.filter.reimbursed']() },
  ]);

  async function load() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const r = await api.get<{ data: Expense[] }>(`/ext/finance/expenses?${params}`);
      expenses = r.data ?? [];
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
  }

  async function createExpense() {
    saving = true;
    try {
      await api.post('/ext/finance/expenses', form);
      showForm = false;
      form = {
        expense_date: new Date().toISOString().slice(0, 10),
        category: 'travel', description: '', amount: 0, currency: 'RON', vendor: '', receipt_url: '',
      };
      await load();
      toast.success(m['finance.expenses.toast.submitted']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  async function approve(id: string) {
    try {
      await api.post(`/ext/finance/expenses/${id}/approve`, {});
      await load();
      toast.success(m['ext.approved']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    }
  }

  $effect(() => { statusFilter; load(); });

  function statusBadge(s: string) {
    return ({
      draft: 'badge-ghost', submitted: 'badge-warning', approved: 'badge-success',
      reimbursed: 'badge-info', rejected: 'badge-error',
    } as Record<string, string>)[s] ?? 'badge-ghost';
  }

  function fmt(n: number, c = 'RON') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(n);
  }
</script>

<ExtensionPageShell
  title={m['finance.expenses.title']()}
  subtitle={m['finance.expenses.subtitle']()}
>
  {#snippet headerExtras()}
    <select bind:value={statusFilter} class="select select-sm max-w-xs">
      {#each statusOptions as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  {/snippet}

  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['finance.expenses.new']()}
    </button>
  {/snippet}

    <ExtensionDataPanel
      {loading}
      empty={!loading && expenses.length === 0}
      emptyTitle={m['finance.expenses.empty']()}
    >
      {#snippet table()}
        <table class="table table-sm">
          <thead>
            <tr>
              <th>{m['finance.expenses.col.date']()}</th>
              <th>{m['finance.expenses.col.category']()}</th>
              <th>{m['finance.expenses.col.vendor']()}</th>
              <th>{m['finance.expenses.col.description']()}</th>
              <th class="text-right">{m['finance.expenses.col.amount']()}</th>
              <th>{m['finance.expenses.col.status']()}</th>
              <th>{m['common.actions']()}</th>
            </tr>
          </thead>
          <tbody>
            {#each expenses as e (e.id)}
              <tr class="hover">
                <td class="text-xs">{e.expense_date}</td>
                <td><span class="badge badge-ghost badge-sm">{e.category}</span></td>
                <td class="text-sm">{e.vendor ?? dash}</td>
                <td class="max-w-xs truncate text-sm">{e.description}</td>
                <td class="text-right text-sm">{fmt(Number(e.amount), e.currency)}</td>
                <td><span class="badge {statusBadge(e.status)} badge-sm">{e.status}</span></td>
                <td>
                  {#if e.status === 'submitted'}
                    <button type="button" class="btn btn-ghost btn-xs" title={m['finance.expenses.action.approve']()} onclick={() => approve(e.id)}>
                      <Check size={13} />
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </ExtensionDataPanel>
</ExtensionPageShell>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['finance.expenses.form.new']()}</h3>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.col.date']()}</span></label>
          <input type="date" class="input input-sm" bind:value={form.expense_date} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.col.category']()}</span></label>
          <select class="select select-sm" bind:value={form.category}>
            <option value="travel">{m['finance.expenses.category.travel']()}</option>
            <option value="meals">{m['finance.expenses.category.meals']()}</option>
            <option value="office">{m['finance.expenses.category.office']()}</option>
            <option value="software">{m['finance.expenses.category.software']()}</option>
            <option value="other">{m['finance.expenses.category.other']()}</option>
          </select>
        </div>
        <div class="form-control col-span-2">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.col.vendor']()}</span></label>
          <input class="input input-sm" bind:value={form.vendor} />
        </div>
        <div class="form-control col-span-2">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.col.description']()} *</span></label>
          <input class="input input-sm" bind:value={form.description} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.col.amount']()}</span></label>
          <input type="number" step="0.01" class="input input-sm" bind:value={form.amount} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
          <input class="input input-sm" bind:value={form.currency} maxlength={3} />
        </div>
        <div class="form-control col-span-2">
          <label class="label py-0"><span class="label-text text-xs">{m['finance.expenses.form.receiptUrl']()}</span></label>
          <input class="input input-sm" bind:value={form.receipt_url} />
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button type="button" class="btn btn-primary btn-sm" disabled={saving || !form.description || form.amount <= 0} onclick={createExpense}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['finance.expenses.form.submit']()}
        </button>
      </div>
    </div>
  </div>
{/if}
