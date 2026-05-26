<script lang="ts">
/**
 * Dashboard — the admin's landing page.
 *
 * UX-refactor goals (wave 40):
 *   - Always-visible "Next steps" guidance, not just a one-shot setup
 *     checklist that vanishes after first collection.
 *   - Stat cards link to the most-relevant deep view, not just the list.
 *   - System status surfaces problems prominently; healthy systems
 *     stay quiet.
 *   - No broken stats (the previous `slow_queries_24h` always-zero card).
 */
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { api } from '$lib/api.js';
import {
  Database,
  Webhook,
  Zap,
  CheckCircle,
  XCircle,
  AlertCircle,
  Key,
  Activity,
  RefreshCw,
  ExternalLink,
  Circle,
  UserPlus,
  Bot,
  Workflow,
  LayoutGrid,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Shield,
  Sparkles,
} from '@lucide/svelte';
import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import SectionCard from '$lib/components/common/SectionCard.svelte';
import EmptyState from '$lib/components/common/EmptyState.svelte';
import Slot from '$lib/components/common/Slot.svelte';
import Sparkline from '$lib/components/common/Sparkline.svelte';
import { auth } from '$lib/auth.svelte.js';
import { extensions } from '$lib/extensions.svelte.js';

interface AdminStats {
  collections?: number;
  active_webhooks?: number;
  api_calls_today?: number;
}
interface SystemStatus {
  database: { status: string; version?: string; tables?: number };
  cache: { status: string };
  uptime: number;
}
interface AuditEvent {
  event_type: string;
  user_id?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  created_at: string;
}
interface CollectionRow {
  name: string;
  label?: string;
  record_count: number;
}

// ── State ───────────────────────────────────────────────────────────────
let statsLoading = $state(true);
let activityLoading = $state(true);
let systemLoading = $state(true);
let collectionsLoading = $state(true);

let stats = $state({
  collections: 0,
  total_records: 0,
  api_calls_today: 0,
  active_webhooks: 0,
});

let activity = $state<AuditEvent[]>([]);
let system = $state<SystemStatus | null>(null);
let collections = $state<CollectionRow[]>([]);
let apiKeys = $state<unknown[]>([]);
let webhooks = $state<unknown[]>([]);
let permissionsCount = $state(0);
let flowsCount = $state(0);

// ── Next steps — adaptive based on platform state ───────────────────────
// Unlike a one-shot onboarding checklist, this is always visible. As the
// operator completes earlier steps, new suggestions surface — keeping the
// dashboard useful long past first-login.
const nextSteps = $derived.by(() => {
  const steps: Array<{ label: string; done: boolean; href: string; hint?: string }> = [];
  steps.push({
    label: 'Create a collection',
    done: collections.length > 0,
    href: `${base}/collections`,
    hint: 'Schema-less tables that hold your data.',
  });
  steps.push({
    label: 'Add permissions',
    done: permissionsCount > 0,
    href: `${base}/permissions`,
    hint: 'Lock collections down by role before going to production.',
  });
  steps.push({
    label: 'Generate an API key',
    done: apiKeys.length > 0,
    href: `${base}/api-keys`,
    hint: 'For server-side / SDK access.',
  });
  steps.push({
    label: 'Set up a webhook',
    done: webhooks.length > 0,
    href: `${base}/webhooks`,
    hint: 'Notify external services on data changes.',
  });
  if (collections.length > 0) {
    steps.push({
      label: 'Build a flow',
      done: flowsCount > 0,
      href: `${base}/flows`,
      hint: 'Wire triggers → actions without writing code.',
    });
  }
  if (extensions.isActive('ai')) {
    steps.push({
      label: 'Try the AI assistant',
      done: false,
      href: `${base}/ai`,
      hint: 'Generate schemas, queries, and insights from natural language.',
    });
  }
  return steps;
});
const pendingSteps = $derived(nextSteps.filter((s) => !s.done));

const largestCollection = $derived(
  collections.slice().sort((a, b) => b.record_count - a.record_count)[0],
);

// ── Load ────────────────────────────────────────────────────────────────
onMount(() => {
  refresh();
});

function refresh(): void {
  loadStats();
  loadActivity();
  loadSystem();
  loadCollections();
  loadSidebarData();
}

async function loadSidebarData() {
  const [keysRes, hooksRes, permsRes, flowsRes] = await Promise.allSettled([
    api.get<{ keys: unknown[] }>('/api/api-keys'),
    api.get<{ webhooks: unknown[] }>('/api/webhooks'),
    api.get<{ permissions?: unknown[]; rules?: unknown[] }>('/api/permissions'),
    api.get<{ flows: unknown[] }>('/api/flows'),
  ]);
  if (keysRes.status === 'fulfilled') apiKeys = keysRes.value.keys ?? [];
  if (hooksRes.status === 'fulfilled') webhooks = hooksRes.value.webhooks ?? [];
  if (permsRes.status === 'fulfilled')
    permissionsCount = (permsRes.value.permissions ?? permsRes.value.rules ?? []).length;
  if (flowsRes.status === 'fulfilled') flowsCount = flowsRes.value.flows?.length ?? 0;
}

async function loadStats() {
  statsLoading = true;
  try {
    const [adminStats, collectionsData] = await Promise.allSettled([
      api.get<AdminStats>('/api/admin/stats'),
      api.get<{ collections: unknown[] }>('/api/collections'),
    ]);
    const s = adminStats.status === 'fulfilled' ? adminStats.value : null;
    const c = collectionsData.status === 'fulfilled' ? collectionsData.value : null;
    stats = {
      collections: s?.collections ?? c?.collections?.length ?? 0,
      total_records: 0,
      api_calls_today: s?.api_calls_today ?? 0,
      active_webhooks: s?.active_webhooks ?? 0,
    };
  } finally {
    statsLoading = false;
  }
}

async function loadActivity() {
  activityLoading = true;
  try {
    const res = await api.get<{ audit: AuditEvent[] }>('/api/admin/audit?limit=10');
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
    system = await api.get<SystemStatus>('/api/admin/status');
  } catch {
    system = null;
  } finally {
    systemLoading = false;
  }
}

async function loadCollections() {
  collectionsLoading = true;
  try {
    const colRes = await api.get<{ collections: Array<{ name: string; label?: string }> }>(
      '/api/collections',
    );
    const cols = colRes.collections ?? [];
    const countResults = await Promise.allSettled(
      cols.map((col) =>
        api.get<{ total?: number; pagination?: { total: number } }>(
          `/api/data/${col.name}?limit=1`,
        ),
      ),
    );
    let totalRecords = 0;
    collections = cols.map((col, i) => {
      const r = countResults[i];
      const total =
        r.status === 'fulfilled' ? (r.value.total ?? r.value.pagination?.total ?? 0) : 0;
      totalRecords += total;
      return { name: col.name, label: col.label, record_count: total };
    });
    stats = { ...stats, collections: cols.length, total_records: totalRecords };
  } catch {
    collections = [];
  } finally {
    collectionsLoading = false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────
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

// System health flag — surfaces a banner when something's wrong.
const systemUnhealthy = $derived(!!system && system.database.status !== 'connected');

// Personal greeting based on time-of-day — gives the dashboard a human
// touch without re-coupling the AI extension into core. AI extension
// can still override the entire hero area via the `dashboard.hero` slot.
function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Working late';
}
const firstName = $derived((auth.user?.name ?? '').split(' ')[0] || '');
const greeting = $derived(firstName ? `${timeOfDayGreeting()}, ${firstName}` : timeOfDayGreeting());

// Mock sparkline series — deterministic per metric so the dashboard
// doesn't reshuffle on every refresh. Replace with real time-series
// from a future /api/admin/stats?series=7d endpoint.
function mockSeries(seed: number, target: number, points = 14): number[] {
  const out: number[] = [];
  let v = Math.max(0, target * 0.6);
  for (let i = 0; i < points; i++) {
    const r = Math.sin((i + 1) * (seed + 0.37)) * 0.5 + 0.5;
    v = v + (target - v) * 0.2 + (r - 0.5) * Math.max(2, target * 0.08);
    out.push(Math.max(0, Math.round(v)));
  }
  out[out.length - 1] = target;
  return out;
}
const collectionsSeries = $derived(mockSeries(1, stats.collections));
const recordsSeries = $derived(mockSeries(2, stats.total_records));
const apiCallsSeries = $derived(mockSeries(3, stats.api_calls_today));
const webhooksSeries = $derived(mockSeries(4, stats.active_webhooks));

const collectionsTrend = $derived(trend(collectionsSeries));
const recordsTrend = $derived(trend(recordsSeries));
const apiCallsTrend = $derived(trend(apiCallsSeries));
const webhooksTrend = $derived(trend(webhooksSeries));

// Trend delta — compares latest point to first point of the series.
function trend(series: number[]): { pct: number; dir: 'up' | 'down' | 'flat' } {
  if (series.length < 2) return { pct: 0, dir: 'flat' };
  const first = series[0];
  const last = series[series.length - 1];
  if (first === 0 && last === 0) return { pct: 0, dir: 'flat' };
  if (first === 0) return { pct: 100, dir: 'up' };
  const pct = Math.round(((last - first) / first) * 100);
  if (Math.abs(pct) < 1) return { pct: 0, dir: 'flat' };
  return { pct: Math.abs(pct), dir: pct > 0 ? 'up' : 'down' };
}
</script>

<div class="space-y-6">
  <!-- Personal greeting hero — replaces the generic "Welcome to Zveltio Studio".
       Big confident type, time-of-day aware, with the subtitle showing
       what's actually going on. -->
  <header class="flex items-end justify-between gap-4 flex-wrap">
    <div>
      <h1 class="display-2xl bg-linear-to-r from-primary to-secondary bg-clip-text text-transparent">
        {greeting}
      </h1>
      <p class="text-sm text-base-content/55 mt-1">
        {#if stats.collections > 0}
          You have <strong class="text-base-content/80">{stats.collections}</strong>
          collection{stats.collections === 1 ? '' : 's'} holding
          <strong class="text-base-content/80">{stats.total_records.toLocaleString()}</strong>
          record{stats.total_records === 1 ? '' : 's'}.
        {:else}
          Let's get your first collection set up — it takes about 30 seconds.
        {/if}
      </p>
    </div>
    <button
      class="btn btn-ghost btn-sm gap-2"
      onclick={refresh}
      aria-label="Refresh dashboard data"
    >
      <RefreshCw size={14} />
      Refresh
    </button>
  </header>

  <!-- System-health banner — only when degraded. Healthy systems are quiet. -->
  {#if systemUnhealthy && system}
    <div role="alert" class="alert alert-warning">
      <AlertCircle size={18} />
      <div class="flex-1">
        <h3 class="font-semibold">Database status: {system.database.status}</h3>
        <p class="text-xs opacity-80">Some features may be unavailable. Check engine logs for details.</p>
      </div>
    </div>
  {/if}

  <!-- Hero slot — extensions inject a featured component (e.g. AI greeting,
       what-changed feed, onboarding nudge). Renders above the stat cards
       only when an extension targets it. -->
  <Slot name="dashboard.hero" ctx={{ user: auth.user, stats }} />

  <!-- Suggestions slot — recommendations from extensions (e.g. AI-suggested
       indices, anomaly alerts, "you have 3 unused API keys"). -->
  <Slot name="dashboard.suggestions" ctx={{ user: auth.user, stats, collections }} />

  <!-- Extension widgets — pre-existing slot, retained for backward compat. -->
  <Slot name="dashboard.widgets" ctx={{ user: auth.user }} />

  <!-- Stat cards — every card links to the most relevant deep view,
       carries a 14-point sparkline trend, and a delta badge. Display
       type and shadow-z1 elevation replace the flat bg-base-200 look. -->
  {#if statsLoading}
    <LoadingSkeleton type="card" rows={4} />
  {:else}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <a
        href="{base}/collections"
        class="card bg-base-100 shadow-z1 hover:shadow-z2 transition-all duration-200 focus-visible:outline-2 focus-visible:outline-primary group"
      >
        <div class="card-body p-4 gap-2">
          <div class="flex items-start justify-between gap-2">
            <div class="p-2 bg-primary/10 rounded-xl"><Database size={18} class="text-primary" /></div>
            {#if collectionsTrend.dir !== 'flat'}
              <span class="badge badge-sm gap-1 {collectionsTrend.dir === 'up' ? 'badge-success' : 'badge-error'} badge-soft">
                {#if collectionsTrend.dir === 'up'}<ArrowUp size={11} />{:else}<ArrowDown size={11} />{/if}
                {collectionsTrend.pct}%
              </span>
            {/if}
          </div>
          <div>
            <p class="display-lg text-base-content">{stats.collections}</p>
            <p class="text-xs text-base-content/55 mt-0.5">Collections</p>
          </div>
          <div class="text-primary">
            <Sparkline data={collectionsSeries} height={26} width={200} color="currentColor" />
          </div>
        </div>
      </a>

      <a
        href={largestCollection ? `${base}/collections/${largestCollection.name}` : `${base}/collections`}
        class="card bg-base-100 shadow-z1 hover:shadow-z2 transition-all duration-200 focus-visible:outline-2 focus-visible:outline-primary"
        title={largestCollection ? `Open ${largestCollection.label ?? largestCollection.name}` : 'Total records across all collections'}
      >
        <div class="card-body p-4 gap-2">
          <div class="flex items-start justify-between gap-2">
            <div class="p-2 bg-secondary/10 rounded-xl"><Database size={18} class="text-secondary" /></div>
            {#if recordsTrend.dir !== 'flat'}
              <span class="badge badge-sm gap-1 {recordsTrend.dir === 'up' ? 'badge-success' : 'badge-error'} badge-soft">
                {#if recordsTrend.dir === 'up'}<ArrowUp size={11} />{:else}<ArrowDown size={11} />{/if}
                {recordsTrend.pct}%
              </span>
            {/if}
          </div>
          <div>
            <p class="display-lg text-base-content">{stats.total_records.toLocaleString()}</p>
            <p class="text-xs text-base-content/55 mt-0.5">Total Records</p>
          </div>
          <div class="text-secondary">
            <Sparkline data={recordsSeries} height={26} width={200} color="currentColor" />
          </div>
        </div>
      </a>

      <a
        href="{base}/request-logs"
        class="card bg-base-100 shadow-z1 hover:shadow-z2 transition-all duration-200 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <div class="card-body p-4 gap-2">
          <div class="flex items-start justify-between gap-2">
            <div class="p-2 bg-accent/10 rounded-xl"><Zap size={18} class="text-accent" /></div>
            {#if apiCallsTrend.dir !== 'flat'}
              <span class="badge badge-sm gap-1 {apiCallsTrend.dir === 'up' ? 'badge-success' : 'badge-error'} badge-soft">
                {#if apiCallsTrend.dir === 'up'}<ArrowUp size={11} />{:else}<ArrowDown size={11} />{/if}
                {apiCallsTrend.pct}%
              </span>
            {/if}
          </div>
          <div>
            <p class="display-lg text-base-content">{stats.api_calls_today.toLocaleString()}</p>
            <p class="text-xs text-base-content/55 mt-0.5">API Calls Today</p>
          </div>
          <div class="text-accent">
            <Sparkline data={apiCallsSeries} height={26} width={200} color="currentColor" />
          </div>
        </div>
      </a>

      <a
        href="{base}/webhooks"
        class="card bg-base-100 shadow-z1 hover:shadow-z2 transition-all duration-200 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <div class="card-body p-4 gap-2">
          <div class="flex items-start justify-between gap-2">
            <div class="p-2 bg-info/10 rounded-xl"><Webhook size={18} class="text-info" /></div>
            {#if webhooksTrend.dir !== 'flat'}
              <span class="badge badge-sm gap-1 {webhooksTrend.dir === 'up' ? 'badge-success' : 'badge-error'} badge-soft">
                {#if webhooksTrend.dir === 'up'}<ArrowUp size={11} />{:else}<ArrowDown size={11} />{/if}
                {webhooksTrend.pct}%
              </span>
            {/if}
          </div>
          <div>
            <p class="display-lg text-base-content">{stats.active_webhooks}</p>
            <p class="text-xs text-base-content/55 mt-0.5">Active Webhooks</p>
          </div>
          <div class="text-info">
            <Sparkline data={webhooksSeries} height={26} width={200} color="currentColor" />
          </div>
        </div>
      </a>
    </div>
  {/if}

  <div class="grid lg:grid-cols-12 gap-4">
    <!-- Left column — activity + collections -->
    <div class="lg:col-span-7 space-y-4">
      <SectionCard title="Recent Activity">
        {#snippet action()}
          <a href="{base}/audit" class="btn btn-ghost btn-xs gap-1">View all <ExternalLink size={10} /></a>
        {/snippet}
        {#if activityLoading}
          <LoadingSkeleton type="list" rows={5} />
        {:else if activity.length === 0}
          <EmptyState
            illustration="spark"
            illustrationColor="text-info"
            title="A quiet moment"
            description="Audit events appear here as admins make changes — try creating a collection or inviting a user to see this fill up."
          />
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
                      <span class="badge badge-ghost badge-sm font-mono text-xs">{eventLabel(entry.event_type)}</span>
                    </td>
                    <td class="text-base-content/60 text-xs font-mono truncate max-w-32">
                      {entry.user_id ? entry.user_id.slice(0, 8) + '…' : '—'}
                    </td>
                    <td class="text-base-content/60 text-xs truncate max-w-32">
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
      </SectionCard>

      <SectionCard title="Collections Overview">
        {#snippet action()}
          <a href="{base}/collections" class="btn btn-ghost btn-xs gap-1">Manage <ExternalLink size={10} /></a>
        {/snippet}
        {#if collectionsLoading}
          <LoadingSkeleton type="table" rows={4} cols={3} />
        {:else if collections.length === 0}
          <EmptyState
            illustration="table"
            illustrationColor="text-primary"
            title="No collections yet"
            description="Collections are the schema-less tables that hold your data."
            actionLabel="Create your first collection"
            actionHref="{base}/collections"
          />
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
                      <div class="flex gap-1 justify-end">
                        <a href="{base}/collections/{col.name}" class="btn btn-ghost btn-xs">Open</a>
                        <a href="{base}/permissions?collection={col.name}" class="btn btn-ghost btn-xs gap-1" title="Permissions for this collection">
                          <Shield size={11} />
                        </a>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </SectionCard>
    </div>

    <!-- Right column — next steps + quick actions + system -->
    <div class="lg:col-span-5 space-y-4">
      <!-- Next Steps — always visible, adaptive -->
      <SectionCard title="Next Steps">
        {#snippet action()}
          {#if pendingSteps.length === 0}
            <span class="text-xs text-success flex items-center gap-1"><Sparkles size={12} /> All set</span>
          {:else}
            <span class="text-xs text-base-content/50">{pendingSteps.length} pending</span>
          {/if}
        {/snippet}
        <ul class="space-y-2">
          {#each nextSteps as step}
            <li>
              <a
                href={step.href}
                class="flex items-start gap-3 p-2 -mx-2 rounded hover:bg-base-200 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
              >
                {#if step.done}
                  <CheckCircle size={16} class="text-success shrink-0 mt-0.5" />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm line-through text-base-content/40">{step.label}</p>
                  </div>
                {:else}
                  <Circle size={16} class="text-base-content/30 shrink-0 mt-0.5" />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-base-content">{step.label}</p>
                    {#if step.hint}
                      <p class="text-xs text-base-content/50 mt-0.5">{step.hint}</p>
                    {/if}
                  </div>
                  <ArrowRight size={14} class="text-base-content/30 shrink-0 mt-1" />
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </SectionCard>

      <SectionCard title="Quick Actions">
        <div class="grid grid-cols-2 gap-2">
          <a href="{base}/collections" class="btn btn-outline btn-sm justify-start gap-2"><Database size={13} /> New Collection</a>
          <a href="{base}/users" class="btn btn-outline btn-sm justify-start gap-2"><UserPlus size={13} /> Invite User</a>
          <a href="{base}/api-keys" class="btn btn-outline btn-sm justify-start gap-2"><Key size={13} /> API Keys</a>
          <a href="{base}/flows" class="btn btn-outline btn-sm justify-start gap-2"><Workflow size={13} /> New Flow</a>
          <a href="{base}/zones" class="btn btn-outline btn-sm justify-start gap-2"><LayoutGrid size={13} /> Zones</a>
          {#if extensions.isActive('ai')}
            <a href="{base}/ai" class="btn btn-outline btn-sm justify-start gap-2"><Bot size={13} /> AI Studio</a>
          {/if}
        </div>
      </SectionCard>

      <SectionCard title="System Status">
        {#if systemLoading}
          <LoadingSkeleton type="text" rows={3} />
        {:else if !system}
          <p class="text-error text-sm">Could not load system status</p>
        {:else}
          {@const DbIcon = statusIcon(system.database.status)}
          {@const CacheIcon = statusIcon(system.cache.status)}
          <div class="space-y-2 text-sm">
            <div class="flex items-center justify-between">
              <span class="text-base-content/60">Database</span>
              <span class="flex items-center gap-1 {statusColor(system.database.status)}">
                <DbIcon size={14} />
                {system.database.status}
              </span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-base-content/60">Cache</span>
              <span class="flex items-center gap-1 {statusColor(system.cache.status)}">
                <CacheIcon size={14} />
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
      </SectionCard>
    </div>
  </div>
</div>
