<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Wallet, Plus, X, Download, LoaderCircle } from '@lucide/svelte';
  import { ENGINE_URL } from '$lib/config.js';

  let periods = $state<any[]>([]);
  let entries = $state<any[]>([]);
  let selectedPeriod = $state<string | null>(null);
  let loading = $state(true);
  let showCreatePeriod = $state(false);
  let saving = $state(false);
  let periodForm = $state({ name: '', period_start: '', period_end: '', pay_date: '' });

  async function loadPeriods() {
    loading = true;
    try {
      const res = await api.get<{ data: any[] }>('/ext/hr/payroll/periods');
      periods = res.data ?? [];
      if (!selectedPeriod && periods.length > 0) selectedPeriod = periods[0].id;
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function loadEntries() {
    if (!selectedPeriod) { entries = []; return; }
    try {
      const res = await api.get<{ data: any[] }>(`/ext/hr/payroll/periods/${selectedPeriod}/entries`);
      entries = res.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function createPeriod() {
    saving = true;
    try {
      await api.post('/ext/hr/payroll/periods', periodForm);
      showCreatePeriod = false;
      periodForm = { name: '', period_start: '', period_end: '', pay_date: '' };
      await loadPeriods();
      toast.success('Period created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function generateEntries(periodId: string) {
    try {
      await api.post(`/ext/hr/payroll/periods/${periodId}/generate`, {});
      await loadEntries();
      toast.success('Entries generated.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  function exportRevisal(periodId: string) {
    window.open(`${ENGINE_URL}/ext/hr/payroll/periods/${periodId}/revisal-export`, '_blank');
  }

  onMount(loadPeriods);
  $effect(() => { selectedPeriod; loadEntries(); });

  function fmt(n: number): string {
    return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' }).format(n);
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Wallet size={20} /> Payroll</h1>
      <p class="text-sm text-base-content/50">Manage payroll periods and generate payslips</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showCreatePeriod = true)}><Plus size={14} /> New period</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="grid grid-cols-12 gap-4">
      <aside class="col-span-3">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-0">
            <div class="p-3 font-medium text-sm border-b border-base-300">Periods</div>
            {#if periods.length === 0}
              <p class="p-4 text-sm text-base-content/50">No periods yet.</p>
            {:else}
              <ul class="menu menu-sm p-2">
                {#each periods as p (p.id)}
                  <li>
                    <button class="{selectedPeriod === p.id ? 'active' : ''}" onclick={() => (selectedPeriod = p.id)}>
                      <div>
                        <div class="font-medium text-xs">{p.name}</div>
                        <div class="text-xs opacity-60">{p.period_start} → {p.period_end}</div>
                        <span class="badge badge-xs">{p.status}</span>
                      </div>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
      </aside>

      <main class="col-span-9">
        {#if !selectedPeriod}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body items-center py-16">
              <p class="text-base-content/50 text-sm">Select a period to view payroll entries.</p>
            </div>
          </div>
        {:else}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-sm font-medium">Entries</h2>
                <div class="flex gap-2">
                  <button class="btn btn-sm btn-outline gap-1" onclick={() => generateEntries(selectedPeriod!)}>
                    <Plus size={13} /> Generate
                  </button>
                  <button class="btn btn-sm btn-ghost gap-1" onclick={() => exportRevisal(selectedPeriod!)}>
                    <Download size={13} /> Revisal XML
                  </button>
                </div>
              </div>
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead><tr><th>Employee</th><th class="text-right">Gross</th><th class="text-right">CAS 25%</th><th class="text-right">CASS 10%</th><th class="text-right">Tax 10%</th><th class="text-right">Net</th></tr></thead>
                  <tbody>
                    {#if entries.length === 0}
                      <tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">No entries — click Generate.</td></tr>
                    {:else}
                      {#each entries as e (e.id)}
                        <tr class="hover">
                          <td class="text-sm">{e.employee_name}</td>
                          <td class="text-right text-sm">{fmt(Number(e.gross_salary))}</td>
                          <td class="text-right text-sm">{fmt(Number(e.cas))}</td>
                          <td class="text-right text-sm">{fmt(Number(e.cass))}</td>
                          <td class="text-right text-sm">{fmt(Number(e.income_tax))}</td>
                          <td class="text-right font-medium text-sm">{fmt(Number(e.net_salary))}</td>
                        </tr>
                      {/each}
                    {/if}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        {/if}
      </main>
    </div>
  {/if}
</div>

{#if showCreatePeriod}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New payroll period</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showCreatePeriod = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Name (e.g. November 2026)</span></label><input class="input input-sm" bind:value={periodForm.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Period start</span></label><input type="date" class="input input-sm" bind:value={periodForm.period_start} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Period end</span></label><input type="date" class="input input-sm" bind:value={periodForm.period_end} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Pay date</span></label><input type="date" class="input input-sm" bind:value={periodForm.pay_date} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showCreatePeriod = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !periodForm.name} onclick={createPeriod}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
