<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
      import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Repeat, Plus, X, AlertCircle, LoaderCircle } from '@lucide/svelte';

  let tab = $state<'subscribers' | 'plans' | 'dunning'>('subscribers');
  let subscribers = $state<any[]>([]);
  let plans = $state<any[]>([]);
  let dunning = $state<any[]>([]);
  let loading = $state(true);
  let showPlanForm = $state(false);
  let saving = $state(false);
  let planForm = $state({ name: '', code: '', price: 0, currency: 'RON', interval: 'monthly', trial_days: 0 });

  async function loadSubs() { const r = await api.get<{ data: any[] }>('/ext/finance/subscriptions/subscribers'); subscribers = r.data ?? []; }
  async function loadPlans() { const r = await api.get<{ data: any[] }>('/ext/finance/subscriptions/plans'); plans = r.data ?? []; }
  async function loadDunning() { const r = await api.get<{ data: any[] }>('/ext/finance/subscriptions/dunning'); dunning = r.data ?? []; }

  async function loadTab() {
    loading = true;
    try {
      if (tab === 'subscribers') await loadSubs();
      else if (tab === 'plans') await loadPlans();
      else await loadDunning();
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  async function createPlan() {
    saving = true;
    try {
      await api.post('/ext/finance/subscriptions/plans', planForm);
      showPlanForm = false;
      planForm = { name: '', code: '', price: 0, currency: 'RON', interval: 'monthly', trial_days: 0 };
      await loadPlans();
      toast.success(m['ext.created']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  $effect(() => { tab; loadTab(); });

  function statusBadge(s: string) {
    return ({ active: 'badge-success', trialing: 'badge-info', past_due: 'badge-warning', cancelled: 'badge-error' } as any)[s] ?? 'badge-ghost';
  }
  function fmt(n: number, c = 'RON') { return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: c }).format(n); }
</script>

<ExtensionPageShell title={m['finance.subscriptions.title']()} subtitle={m['finance.subscriptions.subtitle']()}>
    {#snippet actions()}
    {#if tab === 'plans'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showPlanForm = true)}><Plus size={14} /> {m['finance.subscriptions.btn.newPlan']()}</button>
    {/if}
  {/snippet}

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'subscribers' ? 'tab-active' : ''}" onclick={() => (tab = 'subscribers')}>{m['finance.subscriptions.tab.subscribers']()}</button>
    <button class="tab {tab === 'plans' ? 'tab-active' : ''}" onclick={() => (tab = 'plans')}>{m['finance.subscriptions.tab.plans']()}</button>
    <button class="tab {tab === 'dunning' ? 'tab-active' : ''}" onclick={() => (tab = 'dunning')}>
      <AlertCircle size={13} class="mr-1.5" aria-hidden="true" /> {m['finance.subscriptions.tab.dunning']()}
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'subscribers'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['finance.subscriptions.col.subscriber']()}</th><th>{m['finance.subscriptions.col.plan']()}</th><th>{m['finance.subscriptions.col.started']()}</th><th>{m['finance.subscriptions.col.nextBill']()}</th><th class="text-right">{m['finance.subscriptions.col.mrr']()}</th><th>{m['common.col.status']()}</th></tr></thead>
        <tbody>
          {#if subscribers.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">{m['finance.subscriptions.ui.no_subscribers']()}</td></tr>
          {:else}{#each subscribers as s (s.id)}
            <tr class="hover"><td class="text-sm">{s.subscriber_email ?? s.subscriber_id}</td><td class="text-sm">{s.plan_name}</td><td class="text-xs">{s.started_at?.slice(0, 10)}</td><td class="text-xs">{s.next_billing_date}</td><td class="text-right text-sm">{fmt(Number(s.mrr ?? s.price), s.currency)}</td><td><span class="badge {statusBadge(s.status)} badge-sm">{s.status}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'plans'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.code']()}</th><th>{m['common.col.name']()}</th><th>{m['finance.subscriptions.ui.interval']()}</th><th class="text-right">{m['common.col.price']()}</th><th>{m['finance.subscriptions.ui.trial_days']()}</th></tr></thead>
        <tbody>
          {#if plans.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">{m['finance.subscriptions.ui.no_plans_yet']()}</td></tr>
          {:else}{#each plans as p (p.id)}
            <tr class="hover"><td class="font-mono text-xs">{p.code}</td><td class="text-sm">{p.name}</td><td class="text-sm">{p.interval}</td><td class="text-right text-sm">{fmt(Number(p.price), p.currency)}</td><td class="text-sm">{p.trial_days ?? 0}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['finance.subscriptions.col.subscriber']()}</th><th>{m['finance.subscriptions.col.attempt']()}</th><th>{m['finance.subscriptions.col.lastAttempt']()}</th><th class="text-right">{m['common.col.amount']()}</th><th>{m['common.col.status']()}</th></tr></thead>
        <tbody>
          {#if dunning.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">{m['finance.subscriptions.ui.no_failed_payments']()}</td></tr>
          {:else}{#each dunning as d (d.id)}
            <tr class="hover"><td class="text-sm">{d.subscriber_email}</td><td class="text-sm">{d.attempt_count}</td><td class="text-xs">{d.last_attempt_at?.slice(0, 16)}</td><td class="text-right text-sm">{fmt(Number(d.amount))}</td><td><span class="badge badge-warning badge-sm">{d.status}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</ExtensionPageShell>

{#if showPlanForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['finance.subscriptions.ui.new_plan']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showPlanForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.subscriptions.col.code']()}</span></label><input class="input input-sm font-mono" bind:value={planForm.code} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.subscriptions.col.name']()}</span></label><input class="input input-sm" bind:value={planForm.name} /></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['inventory.col.price']()}</span></label><input type="number" step="0.01" class="input input-sm" bind:value={planForm.price} /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label><input class="input input-sm" bind:value={planForm.currency} maxlength={3} /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.subscriptions.ui.interval']()}</span></label>
            <select class="select select-sm" bind:value={planForm.interval}>
              <option value="monthly">{m['finance.subscriptions.ui.monthly']()}</option><option value="quarterly">{m['finance.subscriptions.ui.quarterly']()}</option><option value="yearly">{m['finance.subscriptions.ui.yearly']()}</option>
            </select>
          </div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['finance.subscriptions.ui.trial_days']()}</span></label><input type="number" class="input input-sm" bind:value={planForm.trial_days} /></div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showPlanForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !planForm.code || !planForm.name} onclick={createPlan}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}{m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
