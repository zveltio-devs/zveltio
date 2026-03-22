<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { api } from '$lib/api.js';
  import {
    Database, Webhook, Activity, Zap, Clock, CheckCircle,
    XCircle, AlertCircle, Plus, Key, Search, GitPullRequest,
    RefreshCw, ExternalLink,
  } from '@lucide/svelte';

  // ── State ──────────────────────────────────────────────────────
  let statsLoading = $state(true);
  let activityLoading = $state(true);
  let systemLoading = $state(true);
  let collectionsLoading = $state(true);

  let stats = $state({
    collections: 0,
    total_records: 0,
    api_calls_today: 0,
    active_webhooks: 0,
    slow_queries_24h: 0,
  });

  let activity = $state<any[]>([]);
  let system = $state<{
    database: { status: string; version: string; tables: number };
    cache: { status: string };
    uptime: number;
  } | null>(null);

  let collections = $state<Array<{ name: string; label?: string; record_count: number }>>([]);

  // ── Load ───────────────────────────────────────────────────────
  onMount(async () => {
    loadStats();
    loadActivity();
    loadSystem();
    loadCollections();
  });

  async function loadStats() {
    statsLoading = true;
    try {
      const [adminStats, collectionsData] = await Promise.allSettled([
        api.get<{
          collections: number;
          active_webhooks: number;
          slow_queries_24h: number;
          api_calls_today: number;
        }>('/api/admin/stats'),
        api.get<{ collections: any[] }>('/api/collections'),
      ]);

      const s = adminStats.status === 'fulfilled' ? adminStats.value : null;
      const c = collectionsData.status === 'fulfilled' ? collectionsData.value : null;

      stats = {
        collections: s?.collections ?? c?.collections?.length ?? 0,
        total_records: 0, // loaded separately in loadCollections
        api_calls_today: s?.api_calls_today ?? 0,
        active_webhooks: s?.active_webhooks ?? 0,
        slow_queries_24h: s?.slow_queries_24h ?? 0,
      };
    } finally {
      statsLoading = false;
    }
  }

  async function loadActivity() {
    activityLoading = true;
    try {
      const res = await api.get<{ audit: any[] }>('/api/admin/audit?limit=10');
      activity = res.audit ?? [];
    } catch {
      activity = [];
    } finally {
      activityLoading = false;
    }
  }

  async function loadSystem() {
    systemLoading = true;
    try {
      const res = await api.get<any>('/api/admin/status');
      system = res;
    } catch {
      system = null;
    } finally {
      systemLoading = false;
    }
  }

  async function loadCollections() {
    collectionsLoading = true;
    try {
      const colRes = await api.get<{ collections: any[] }>('/api/collections');
      const cols = colRes.collections ?? [];

      // Fetch record counts in parallel (limit=1 gives us total in pagination)
      const countResults = await Promise.allSettled(
        cols.map((col: any) =>
          api.get<{ total: number; pagination?: { total: number } }>(
            `/api/data/${col.name}?limit=1`,
          ),
        ),
      );

      let totalRecords = 0;
      collections = cols.map((col: any, i: number) => {
        const r = countResults[i];
        const total =
          r.status === 'fulfilled'
            ? (r.value.total ?? r.value.pagination?.total ?? 0)
            : 0;
        totalRecords += total;
        return { name: col.name, label: col.label, record_count: total };
      });

      // Update total_records in stats
      stats = { ...stats, collections: cols.length, total_records: totalRecords };
    } catch {
      collections = [];
    } finally {
      collectionsLoading = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────
  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    return `${h}h ${m}m`;
  }

  function formatRelative(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function statusColor(status: string): string {
    if (status === 'connected') return 'text-success';
    if (status === 'not_configured') return 'text-warning';
    return 'text-error';
  }

  function statusIcon(status: string) {
    if (status === 'connected') return CheckCircle;
    if (status === 'not_configured') return AlertCircle;
    return XCircle;
  }

  function eventLabel(type: string): string {
    return type.replace(/_/g, ' ').replace(/\./g, ' › ');
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Dashboard</h1>
      <p class="text-base-content/60 mt-1">Welcome to Zveltio Studio</p>
    </div>
    <button
      class="btn btn-ghost btn-sm gap-2"
      onclick={() => { loadStats(); loadActivity(); loadSystem(); loadCollections(); }}
    >
      <RefreshCw size={14} />
      Refresh
    </button>
  </div>

  <!-- Stats cards -->
  {#if statsLoading}
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
      {#each [1, 2, 3, 4, 5] as _}
        <div class="card bg-base-200 animate-pulse h-24"></div>
      {/each}
    </div>
  {:else}
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
      <div class="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer" role="button" tabindex="0" onclick={() => goto(`${base}/collections`)} onkeypress={() => {}}>
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-primary/10 rounded-lg shrink-0">
              <Database size={20} class="text-primary" />
            </div>
            <div class="min-w-0">
              <p class="text-2xl font-bold">{stats.collections}</p>
              <p class="text-xs text-base-content/60 truncate">Collections</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-secondary/10 rounded-lg shrink-0">
              <Database size={20} class="text-secondary" />
            </div>
            <div class="min-w-0">
              <p class="text-2xl font-bold">{stats.total_records.toLocaleString()}</p>
              <p class="text-xs text-base-content/60 truncate">Total Records</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-accent/10 rounded-lg shrink-0">
              <Zap size={20} class="text-accent" />
            </div>
            <div class="min-w-0">
              <p class="text-2xl font-bold">{stats.api_calls_today.toLocaleString()}</p>
              <p class="text-xs text-base-content/60 truncate">API Calls Today</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer" role="button" tabindex="0" onclick={() => goto(`${base}/webhooks`)} onkeypress={() => {}}>
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-info/10 rounded-lg shrink-0">
              <Webhook size={20} class="text-info" />
            </div>
            <div class="min-w-0">
              <p class="text-2xl font-bold">{stats.active_webhooks}</p>
              <p class="text-xs text-base-content/60 truncate">Active Webhooks</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card bg-base-200 {stats.slow_queries_24h > 0 ? 'border border-warning/40' : ''}">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="p-2 {stats.slow_queries_24h > 0 ? 'bg-warning/10' : 'bg-success/10'} rounded-lg shrink-0">
              <Clock size={20} class="{stats.slow_queries_24h > 0 ? 'text-warning' : 'text-success'}" />
            </div>
            <div class="min-w-0">
              <p class="text-2xl font-bold">{stats.slow_queries_24h}</p>
              <p class="text-xs text-base-content/60 truncate">Slow Queries (24h)</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Recent Activity -->
    <div class="lg:col-span-2 card bg-base-200">
      <div class="card-body p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-semibold flex items-center gap-2">
            <Activity size={16} />
            Recent Activity
          </h2>
          <a href="{base}/audit" class="btn btn-ghost btn-xs gap-1">
            View all <ExternalLink size={10} />
          </a>
        </div>

        {#if activityLoading}
          <div class="space-y-2">
            {#each [1, 2, 3, 4, 5] as _}
              <div class="h-8 bg-base-300 rounded animate-pulse"></div>
            {/each}
          </div>
        {:else if activity.length === 0}
          <p class="text-base-content/50 text-sm text-center py-6">No recent audit events</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="table table-xs w-full">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>User</th>
                  <th>Resource</th>
                  <th class="text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {#each activity as entry}
                  <tr class="hover">
                    <td>
                      <span class="badge badge-ghost badge-sm font-mono text-xs">
                        {eventLabel(entry.event_type)}
                      </span>
                    </td>
                    <td class="text-base-content/60 text-xs font-mono truncate max-w-[8rem]">
                      {entry.user_id ? entry.user_id.slice(0, 8) + '…' : '—'}
                    </td>
                    <td class="text-base-content/60 text-xs truncate max-w-[8rem]">
                      {entry.resource_type ?? '—'}
                      {#if entry.resource_id}
                        <span class="font-mono">{entry.resource_id.slice(0, 6)}…</span>
                      {/if}
                    </td>
                    <td class="text-right text-base-content/50 text-xs whitespace-nowrap">
                      {formatRelative(entry.created_at)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    </div>

    <!-- Right column: Quick Actions + System Status -->
    <div class="space-y-4">
      <!-- Quick Actions -->
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h2 class="font-semibold mb-3">Quick Actions</h2>
          <div class="grid grid-cols-2 gap-2">
            <a href="{base}/collections" class="btn btn-outline btn-sm gap-2 justify-start">
              <Plus size={14} />
              New Collection
            </a>
            <a href="{base}/api-keys" class="btn btn-outline btn-sm gap-2 justify-start">
              <Key size={14} />
              API Keys
            </a>
            <a href="{base}/insights" class="btn btn-outline btn-sm gap-2 justify-start">
              <Search size={14} />
              Slow Queries
            </a>
            <button
              class="btn btn-outline btn-sm gap-2 justify-start"
              onclick={async () => {
                try {
                  await api.post('/api/admin/migrate', {});
                  alert('Migrations complete');
                } catch (e: any) {
                  alert('Migration error: ' + e.message);
                }
              }}
            >
              <GitPullRequest size={14} />
              Run Migrations
            </button>
          </div>
        </div>
      </div>

      <!-- System Status -->
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h2 class="font-semibold mb-3">System Status</h2>
          {#if systemLoading}
            <div class="space-y-2">
              {#each [1, 2, 3] as _}
                <div class="h-6 bg-base-300 rounded animate-pulse"></div>
              {/each}
            </div>
          {:else if !system}
            <p class="text-error text-sm">Could not load system status</p>
          {:else}
            <div class="space-y-2 text-sm">
              <div class="flex items-center justify-between">
                <span class="text-base-content/60">Database</span>
                <span class="flex items-center gap-1 {statusColor(system.database.status)}">
                  <svelte:component this={statusIcon(system.database.status)} size={14} />
                  {system.database.status}
                </span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-base-content/60">Cache</span>
                <span class="flex items-center gap-1 {statusColor(system.cache.status)}">
                  <svelte:component this={statusIcon(system.cache.status)} size={14} />
                  {system.cache.status}
                </span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-base-content/60">Uptime</span>
                <span class="text-base-content font-mono">{formatUptime(system.uptime)}</span>
              </div>
              {#if system.database.tables}
                <div class="flex items-center justify-between">
                  <span class="text-base-content/60">DB Tables</span>
                  <span class="text-base-content font-mono">{system.database.tables}</span>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- Collections Overview -->
  <div class="card bg-base-200">
    <div class="card-body p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-semibold flex items-center gap-2">
          <Database size={16} />
          Collections Overview
        </h2>
        <a href="{base}/collections" class="btn btn-ghost btn-xs gap-1">
          Manage <ExternalLink size={10} />
        </a>
      </div>

      {#if collectionsLoading}
        <div class="space-y-2">
          {#each [1, 2, 3, 4] as _}
            <div class="h-8 bg-base-300 rounded animate-pulse"></div>
          {/each}
        </div>
      {:else if collections.length === 0}
        <div class="text-center py-8">
          <p class="text-base-content/50 text-sm mb-3">No collections yet</p>
          <a href="{base}/collections" class="btn btn-primary btn-sm gap-2">
            <Plus size={14} />
            Create your first collection
          </a>
        </div>
      {:else}
        <div class="overflow-x-auto">
          <table class="table table-sm w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th class="text-right">Records</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each collections as col}
                <tr class="hover">
                  <td>
                    <div class="flex items-center gap-2">
                      <Database size={14} class="text-base-content/40" />
                      <span class="font-medium">{col.label ?? col.name}</span>
                      {#if col.label}
                        <span class="text-base-content/40 text-xs font-mono">{col.name}</span>
                      {/if}
                    </div>
                  </td>
                  <td class="text-right font-mono text-sm">{col.record_count.toLocaleString()}</td>
                  <td class="text-right">
                    <a
                      href="{base}/collections/{col.name}"
                      class="btn btn-ghost btn-xs"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</div>
