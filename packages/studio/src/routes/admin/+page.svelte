<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Database, Users, Webhook, Activity } from '@lucide/svelte';

  let stats = $state({ collections: 0, users: 0, webhooks: 0, uptime: 0 });
  let loading = $state(true);

  onMount(async () => {
    try {
      const [colls, usrs, whs, health] = await Promise.allSettled([
        api.get<{ collections: any[] }>('/api/collections'),
        api.get<{ users: any[]; pagination: any }>('/api/users'),
        api.get<{ webhooks: any[] }>('/api/webhooks'),
        api.get<{ uptime: number }>('/health'),
      ]);

      stats = {
        collections: colls.status === 'fulfilled' ? colls.value.collections.length : 0,
        users: usrs.status === 'fulfilled' ? usrs.value.pagination.total : 0,
        webhooks: whs.status === 'fulfilled' ? whs.value.webhooks.length : 0,
        uptime: health.status === 'fulfilled' ? health.value.uptime : 0,
      };
    } finally {
      loading = false;
    }
  });

  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Dashboard</h1>
    <p class="text-base-content/60 mt-1">Welcome to Zveltio Studio</p>
  </div>

  {#if loading}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {#each [1, 2, 3, 4] as _}
        <div class="card bg-base-200 animate-pulse h-24"></div>
      {/each}
    </div>
  {:else}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-primary/10 rounded-lg">
              <Database size={20} class="text-primary" />
            </div>
            <div>
              <p class="text-2xl font-bold">{stats.collections}</p>
              <p class="text-xs text-base-content/60">Collections</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-secondary/10 rounded-lg">
              <Users size={20} class="text-secondary" />
            </div>
            <div>
              <p class="text-2xl font-bold">{stats.users}</p>
              <p class="text-xs text-base-content/60">Users</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-accent/10 rounded-lg">
              <Webhook size={20} class="text-accent" />
            </div>
            <div>
              <p class="text-2xl font-bold">{stats.webhooks}</p>
              <p class="text-xs text-base-content/60">Webhooks</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-success/10 rounded-lg">
              <Activity size={20} class="text-success" />
            </div>
            <div>
              <p class="text-2xl font-bold">{formatUptime(stats.uptime)}</p>
              <p class="text-xs text-base-content/60">Uptime</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
