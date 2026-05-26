<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
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
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function loadEntries() {
  if (!selectedPeriod) {
    entries = [];
    return;
  }
  try {
    const res = await api.get<{ data: any[] }>(`/ext/hr/payroll/periods/${selectedPeriod}/entries`);
    entries = res.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function createPeriod() {
  saving = true;
  try {
    await api.post('/ext/hr/payroll/periods', periodForm);
    showCreatePeriod = false;
    periodForm = { name: '', period_start: '', period_end: '', pay_date: '' };
    await loadPeriods();
    toast.success(m['hr.payroll.toast.periodCreated']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function generateEntries(periodId: string) {
  try {
    await api.post(`/ext/hr/payroll/periods/${periodId}/generate`, {});
    await loadEntries();
    toast.success(m['hr.payroll.toast.entriesGenerated']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

function exportRevisal(periodId: string) {
  window.open(`${ENGINE_URL}/ext/hr/payroll/periods/${periodId}/revisal-export`, '_blank');
}

onMount(loadPeriods);
$effect(() => {
  selectedPeriod;
  loadEntries();
});

function fmt(n: number): string {
  return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' }).format(n);
}
</script>

<ExtensionPageShell title={m['hr.payroll.title']()} subtitle={m['hr.payroll.subtitle']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showCreatePeriod = true)}><Plus size={14} /> {m['hr.payroll.btn.newPeriod']()}</button>
  {/snippet}

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="grid grid-cols-12 gap-4">
      <aside class="col-span-3">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-0">
            <div class="p-3 font-medium text-sm border-b border-base-300">{m['hr.payroll.tab.periods']()}</div>
            {#if periods.length === 0}
              <p class="p-4 text-sm text-base-content/50">{m['hr.payroll.empty.periods']()}</p>
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
              <p class="text-base-content/50 text-sm">{m['hr.payroll.selectPeriod']()}</p>
            </div>
          </div>
        {:else}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-sm font-medium">{m['hr.payroll.ui.entries']()}</h2>
                <div class="flex gap-2">
                  <button class="btn btn-sm btn-outline gap-1" onclick={() => generateEntries(selectedPeriod!)}>
                    <Plus size={13} /> {m['hr.payroll.btn.generate']()}
                  </button>
                  <button class="btn btn-sm btn-ghost gap-1" onclick={() => exportRevisal(selectedPeriod!)}>
                    <Download size={13} /> {m['hr.payroll.btn.revisal']()}
                  </button>
                </div>
              </div>
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead><tr><th>{m['common.col.employee']()}</th><th class="text-right">{m['hr.payroll.col.gross']()}</th><th class="text-right">CAS 25%</th><th class="text-right">CASS 10%</th><th class="text-right">Tax 10%</th><th class="text-right">{m['hr.payroll.col.net']()}</th></tr></thead>
                  <tbody>
                    {#if entries.length === 0}
                      <tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">{m['hr.payroll.ui.no_entries_click_generate']()}</td></tr>
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
</ExtensionPageShell>

{#if showCreatePeriod}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['hr.payroll.ui.new_payroll_period']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showCreatePeriod = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['hr.payroll.ui.name_e_g_november_2026']()}</span></label><input class="input input-sm" bind:value={periodForm.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['compliance.ro.saft.ui.period_start']()}</span></label><input type="date" class="input input-sm" bind:value={periodForm.period_start} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['compliance.ro.saft.ui.period_end']()}</span></label><input type="date" class="input input-sm" bind:value={periodForm.period_end} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['hr.payroll.ui.pay_date']()}</span></label><input type="date" class="input input-sm" bind:value={periodForm.pay_date} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showCreatePeriod = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !periodForm.name} onclick={createPeriod}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
