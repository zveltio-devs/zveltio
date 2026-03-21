<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let plans = $state<any[]>([]);
  let subscriptions = $state<any[]>([]);
  let usageSummary = $state<Record<string, number>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);

  let currentSub = $derived(subscriptions[0] ?? null);
  let currentPlan = $derived(
    currentSub ? plans.find((p: any) => p.id === currentSub.plan_id) ?? null : null,
  );

  function usagePct(used: number, limit: number): number {
    if (!limit) return 0;
    return Math.min(100, Math.round((used / limit) * 100));
  }

  onMount(async () => {
    try {
      const [plansRes, subsRes, usageRes] = await Promise.all([
        api.get('/extensions/billing/plans'),
        api.get('/extensions/billing/subscriptions'),
        api.get('/extensions/billing/usage'),
      ]);
      plans = plansRes.plans ?? [];
      subscriptions = subsRes.subscriptions ?? [];

      // Aggregate usage per event_type
      const agg: Record<string, number> = {};
      for (const row of usageRes.usage ?? []) {
        agg[row.event_type] = (agg[row.event_type] ?? 0) + Number(row.total);
      }
      usageSummary = agg;
    } catch (e: any) {
      error = e.message ?? 'Failed to load billing data';
    } finally {
      loading = false;
    }
  });

  async function upgradePlan(planId: string) {
    // Redirect to Stripe or handle plan change
    alert('Upgrade flow: integrate with Stripe Checkout for plan ' + planId);
  }
</script>

<div class="billing-page">
  <h1>Billing &amp; Subscription</h1>

  {#if loading}
    <p class="loading">Loading billing data…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <section class="current-plan">
      <h2>Current Plan</h2>
      {#if currentSub && currentPlan}
        <div class="plan-card">
          <div class="plan-header">
            <span class="plan-name">{currentPlan.name}</span>
            <span class="plan-status status-{currentSub.status}">{currentSub.status}</span>
          </div>
          <p class="plan-price">
            ${((currentPlan.price_cents ?? 0) / 100).toFixed(2)} / {currentPlan.interval}
          </p>
          {#if currentSub.current_period_end}
            <p class="plan-renewal">
              Renews: {new Date(currentSub.current_period_end).toLocaleDateString()}
            </p>
          {/if}
        </div>
      {:else}
        <p class="no-plan">No active subscription. Choose a plan below.</p>
      {/if}
    </section>

    <section class="usage-section">
      <h2>Usage This Period</h2>
      {#each [
        { key: 'api_call', label: 'API Calls', limitKey: 'api_calls' },
        { key: 'storage_write', label: 'Storage Writes', limitKey: 'storage_mb' },
        { key: 'record_created', label: 'Records Created', limitKey: 'records' },
      ] as metric}
        {@const used = usageSummary[metric.key] ?? 0}
        {@const limit = currentPlan?.limits?.[metric.limitKey] ?? 0}
        {@const pct = usagePct(used, limit)}
        <div class="usage-bar-item">
          <div class="usage-bar-label">
            <span>{metric.label}</span>
            <span>{used.toLocaleString()} {limit ? `/ ${limit.toLocaleString()}` : ''}</span>
          </div>
          <div class="usage-bar-track">
            <div
              class="usage-bar-fill"
              style="width: {pct}%; background: {pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e'}"
            ></div>
          </div>
          {#if limit}
            <span class="usage-pct">{pct}%</span>
          {/if}
        </div>
      {/each}
    </section>

    <section class="plans-section">
      <h2>Available Plans</h2>
      <div class="plans-grid">
        {#each plans as plan}
          <div class="plan-card" class:active={currentPlan?.id === plan.id}>
            <h3>{plan.name}</h3>
            <p class="price">${((plan.price_cents ?? 0) / 100).toFixed(2)} / {plan.interval}</p>
            {#if plan.limits}
              {@const limits = typeof plan.limits === 'string' ? JSON.parse(plan.limits) : plan.limits}
              <ul class="limits">
                {#each Object.entries(limits) as [key, val]}
                  <li>{key.replace(/_/g, ' ')}: {String(val)}</li>
                {/each}
              </ul>
            {/if}
            {#if currentPlan?.id !== plan.id}
              <button class="btn-upgrade" onclick={() => upgradePlan(plan.id)}>
                Upgrade to {plan.name}
              </button>
            {:else}
              <span class="current-badge">Current Plan</span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .billing-page { max-width: 960px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1.5rem; }
  h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; }
  section { margin-bottom: 2rem; }
  .loading { color: #6b7280; }
  .error { color: #ef4444; }
  .plan-card {
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem;
    background: #fff; margin-bottom: 0.75rem;
  }
  .plan-card.active { border-color: #6366f1; box-shadow: 0 0 0 2px #6366f133; }
  .plan-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .plan-name { font-weight: 600; font-size: 1.1rem; }
  .plan-status {
    padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500;
  }
  .status-active { background: #dcfce7; color: #16a34a; }
  .status-past_due { background: #fef9c3; color: #ca8a04; }
  .status-canceled { background: #fee2e2; color: #dc2626; }
  .plan-price, .plan-renewal { color: #6b7280; font-size: 0.9rem; }
  .no-plan { color: #6b7280; }
  .usage-bar-item { margin-bottom: 1rem; }
  .usage-bar-label { display: flex; justify-content: space-between; font-size: 0.875rem; margin-bottom: 4px; }
  .usage-bar-track { height: 8px; background: #f3f4f6; border-radius: 9999px; overflow: hidden; }
  .usage-bar-fill { height: 100%; border-radius: 9999px; transition: width 0.3s; }
  .usage-pct { font-size: 0.75rem; color: #6b7280; }
  .plans-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .price { font-size: 1.5rem; font-weight: 700; margin: 0.5rem 0; }
  .limits { list-style: none; padding: 0; font-size: 0.85rem; color: #6b7280; }
  .limits li::before { content: '✓ '; color: #22c55e; }
  .btn-upgrade {
    margin-top: 1rem; width: 100%; padding: 0.5rem; background: #6366f1;
    color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;
  }
  .btn-upgrade:hover { background: #4f46e5; }
  .current-badge { display: block; margin-top: 1rem; text-align: center; color: #22c55e; font-weight: 500; }
</style>
