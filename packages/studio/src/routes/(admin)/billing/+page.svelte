<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { CreditCard, BarChart2, LoaderCircle } from '@lucide/svelte';

let tab = $state<'billing' | 'usage'>('billing');
let plans = $state<any[]>([]);
let subscriptions = $state<any[]>([]);
let usageSummary = $state<Record<string, number>>({});
let loading = $state(true);

const currentSub = $derived(subscriptions[0] ?? null);
const currentPlan = $derived(
  currentSub ? (plans.find((p: any) => p.id === currentSub.plan_id) ?? null) : null,
);

const USAGE_METRICS = $derived([
  { key: 'api_call', label: m['billing.metric.apiCalls'](), limitKey: 'api_calls' },
  { key: 'storage_write', label: m['billing.metric.storageWrites'](), limitKey: 'storage_mb' },
  { key: 'record_created', label: m['billing.metric.recordsCreated'](), limitKey: 'records' },
]);

function usagePct(used: number, limit: number): number {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

onMount(async () => {
  try {
    const [plansRes, subsRes, usageRes] = await Promise.all([
      api.get<{ plans: any[] }>('/ext/billing/plans'),
      api.get<{ subscriptions: any[] }>('/ext/billing/subscriptions'),
      api.get<{ usage: any[] }>('/ext/billing/usage'),
    ]);
    plans = plansRes.plans ?? [];
    subscriptions = subsRes.subscriptions ?? [];
    const agg: Record<string, number> = {};
    for (const row of usageRes.usage ?? []) {
      agg[row.event_type] = (agg[row.event_type] ?? 0) + Number(row.total);
    }
    usageSummary = agg;
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
});

function statusBadge(s: string) {
  return (
    (
      { active: 'badge-success', past_due: 'badge-warning', canceled: 'badge-error' } as Record<
        string,
        string
      >
    )[s] ?? 'badge-ghost'
  );
}
</script>

<ExtensionPageShell title={m['billing.title']()} subtitle={m['billing.subtitle']()}>
    <div class="space-y-4">
      <div class="tabs tabs-boxed bg-base-200 w-fit">
        <button class="tab {tab === 'billing' ? 'tab-active' : ''}" onclick={() => (tab = 'billing')}>
          <CreditCard size={13} class="mr-1.5" /> {m['billing.tab.subscription']()}
        </button>
        <button class="tab {tab === 'usage' ? 'tab-active' : ''}" onclick={() => (tab = 'usage')}>
          <BarChart2 size={13} class="mr-1.5" /> {m['billing.tab.usage']()}
        </button>
      </div>

      {#if loading}
        <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
      {:else if tab === 'billing'}
        {#if currentSub && currentPlan}
          <div class="card bg-base-200 border border-primary/30">
            <div class="card-body p-4 gap-2">
              <div class="flex items-center justify-between">
                <h3 class="font-semibold">{currentPlan.name}</h3>
                <span class="badge badge-sm {statusBadge(currentSub.status)}">{currentSub.status}</span>
              </div>
              <p class="text-lg font-bold">
                ${((currentPlan.price_cents ?? 0) / 100).toFixed(2)}
                <span class="text-sm font-normal text-base-content/50"> / {currentPlan.interval}</span>
              </p>
            </div>
          </div>
        {:else}
          <div class="card bg-base-200">
            <div class="card-body items-center py-10 text-base-content/50 text-sm">{m['billing.empty.noSubscription']()}</div>
          </div>
        {/if}

        <h3 class="text-sm font-medium text-base-content/70 uppercase tracking-wider">{m['billing.ui.available_plans']()}</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {#each plans as plan (plan.id)}
            <div class="card bg-base-200 border {currentPlan?.id === plan.id ? 'border-primary/50' : 'border-base-300'}">
              <div class="card-body p-4 gap-2">
                <div class="flex items-center justify-between">
                  <h3 class="font-semibold">{plan.name}</h3>
                  {#if currentPlan?.id === plan.id}<span class="badge badge-primary badge-sm">{m['billing.badge.current']()}</span>{/if}
                </div>
                <p class="text-lg font-bold">
                  ${((plan.price_cents ?? 0) / 100).toFixed(2)}
                  <span class="text-sm font-normal text-base-content/50"> / {plan.interval}</span>
                </p>
                {#if plan.limits}
                  {@const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : plan.limits}
                  <ul class="text-xs text-base-content/60 space-y-0.5">
                    {#each Object.entries(limits) as [key, val]}
                      <li>✓ {key.replace(/_/g, ' ')}: {String(val)}</li>
                    {/each}
                  </ul>
                {/if}
                {#if currentPlan?.id !== plan.id}
                  <button class="btn btn-primary btn-sm mt-2">{m['billing.btn.upgradeTo']()} {plan.name}</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-4">
            <h3 class="font-medium text-sm">{m['billing.ui.usage_this_period']()}</h3>
            {#each USAGE_METRICS as metric}
              {@const used = usageSummary[metric.key] ?? 0}
              {@const limit = currentPlan?.limits?.[metric.limitKey] ?? 0}
              {@const pct = usagePct(used, limit)}
              <div class="space-y-1">
                <div class="flex items-center justify-between text-sm">
                  <span>{metric.label}</span>
                  <span class="text-base-content/60">{used.toLocaleString()}{limit ? ` / ${limit.toLocaleString()}` : ''}</span>
                </div>
                {#if limit}
                  <div class="w-full bg-base-300 rounded-full h-2">
                    <div
                      class="h-2 rounded-full transition-all {pct > 90 ? 'bg-error' : pct > 70 ? 'bg-warning' : 'bg-success'}"
                      style="width: {pct}%"
                    ></div>
                  </div>
                  <p class="text-xs text-base-content/40">{m['billing.usage.percentUsed']({ pct: String(pct) })}</p>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
</ExtensionPageShell>
