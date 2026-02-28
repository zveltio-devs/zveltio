<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import Hash from '@lucide/svelte/icons/hash.svelte';
  import Clock from '@lucide/svelte/icons/clock.svelte';
  import TrendingUp from '@lucide/svelte/icons/trending-up.svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw.svelte';

  interface Props {
    collection: string;
  }

  let { collection }: Props = $props();

  interface Stats {
    total: number;
    created_today: number;
    updated_today: number;
    created_this_week: number;
  }

  let stats = $state<Stats | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    try {
      // Fetch total + a small sample to compute stats
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      const [total, createdToday, updatedToday, createdWeek] = await Promise.all([
        api.get<{ pagination: { total: number } }>(`/api/data/${collection}?limit=1`),
        api.get<{ pagination: { total: number } }>(`/api/data/${collection}?limit=1&filter[created_at][gte]=${today.toISOString()}`),
        api.get<{ pagination: { total: number } }>(`/api/data/${collection}?limit=1&filter[updated_at][gte]=${today.toISOString()}`),
        api.get<{ pagination: { total: number } }>(`/api/data/${collection}?limit=1&filter[created_at][gte]=${weekAgo.toISOString()}`),
      ]);

      stats = {
        total: total.pagination?.total ?? 0,
        created_today: createdToday.pagination?.total ?? 0,
        updated_today: updatedToday.pagination?.total ?? 0,
        created_this_week: createdWeek.pagination?.total ?? 0,
      };
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load stats';
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <h3 class="font-semibold text-sm">Collection Stats</h3>
    <button class="btn btn-xs btn-ghost" onclick={load} title="Refresh"><RefreshCw size={12} /></button>
  </div>

  {#if error}
    <div class="alert alert-error text-xs py-2">{error}</div>
  {:else if loading}
    <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
  {:else if stats}
    <div class="grid grid-cols-2 gap-3">
      <div class="stat bg-base-200 rounded-xl p-3">
        <div class="stat-figure text-primary"><Hash size={24} /></div>
        <div class="stat-title text-xs">Total Records</div>
        <div class="stat-value text-2xl">{stats.total.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl p-3">
        <div class="stat-figure text-success"><TrendingUp size={24} /></div>
        <div class="stat-title text-xs">Created This Week</div>
        <div class="stat-value text-2xl text-success">{stats.created_this_week}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl p-3">
        <div class="stat-figure text-info"><Clock size={24} /></div>
        <div class="stat-title text-xs">Created Today</div>
        <div class="stat-value text-2xl">{stats.created_today}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl p-3">
        <div class="stat-figure text-warning"><Clock size={24} /></div>
        <div class="stat-title text-xs">Updated Today</div>
        <div class="stat-value text-2xl">{stats.updated_today}</div>
      </div>
    </div>
  {/if}
</div>
