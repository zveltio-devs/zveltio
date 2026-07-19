<script lang="ts">
/**
 * Employee dashboard — the signed-in user's personalised home in the client app.
 *
 * Data comes from /ext/analytics/dashboard (permission-resolved server-side). The user
 * picks which cards to show; the engine clamps choices to their role's rights.
 */
import {
  Users,
  Database,
  Activity,
  ShieldCheck,
  Lock,
  ScrollText,
  Server,
  HardDriveDownload,
  CircleCheck,
  TriangleAlert,
  SlidersHorizontal,
  RotateCcw,
} from '@lucide/svelte';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

type AuditRow = {
  event_type?: string;
  resource_type?: string;
  resource_id?: string;
  created_at: string;
};
type WidgetData = {
  welcome?: { organization?: string };
  health?: { ok?: boolean };
  people?: { total?: number; admins?: number };
  data?: { records_estimate?: number; collections?: number };
  activity?: { today?: number; recent?: AuditRow[] };
  trust?: { encryption?: boolean; last_backup?: string | null };
};
type Dashboard = {
  widgets: string[];
  available: string[];
  personalized: boolean;
  catalog: Array<{ id: string; removable: boolean }>;
  data: WidgetData;
};

const LABELS: Record<string, string> = {
  welcome: 'Welcome',
  health: 'System health',
  people: 'People',
  data: 'Data & records',
  activity: 'Recent activity',
  trust: 'Data protection',
};

let dash = $state<Dashboard | null>(data.dashboard);
let editing = $state(false);
let saving = $state(false);
let draft = $state<Record<string, boolean>>({});

const nf = new Intl.NumberFormat();
const fmtNum = (n: number | undefined) => nf.format(n ?? 0);
const fmtDateTime = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '');

async function mutate(method: 'PUT' | 'DELETE', body?: unknown) {
  saving = true;
  try {
    const res = await fetch(`${data.engineUrl}/ext/analytics/dashboard`, {
      method,
      credentials: 'include',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) dash = await res.json();
    editing = false;
  } finally {
    saving = false;
  }
}

function startEditing() {
  if (!dash) return;
  const shown = new Set(dash.widgets);
  draft = Object.fromEntries(dash.catalog.map((w) => [w.id, shown.has(w.id)]));
  editing = true;
}
const saveEditing = () =>
  dash && mutate('PUT', { widgets: dash.catalog.filter((w) => draft[w.id]).map((w) => w.id) });

function describe(e: AuditRow): string {
  const verb = String(e.event_type ?? '')
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return (
    verb +
    (e.resource_type ? ` — ${e.resource_type}${e.resource_id ? ` ${e.resource_id}` : ''}` : '')
  );
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
const orgName = $derived(dash?.data?.welcome?.organization ?? 'your organization');
const choosable = $derived(
  dash
    ? dash.catalog.filter((w) => dash!.widgets.includes(w.id) || dash!.available.includes(w.id))
    : [],
);
const has = (id: string) => !!dash?.widgets.includes(id);
</script>

<div class="max-w-5xl mx-auto space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">{greeting()}, {data.user?.name ?? ''}</h1>
      <p class="text-base-content/60 text-sm">Here's how {orgName} is doing.</p>
    </div>
    {#if dash && !editing}
      <button class="btn btn-sm btn-ghost gap-2" onclick={startEditing}>
        <SlidersHorizontal size={16} /> Personalize
      </button>
    {/if}
  </div>

  {#if !dash}
    <div class="alert alert-warning">Couldn't load your dashboard. Please refresh.</div>
  {:else if editing}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-5 space-y-3">
        <h2 class="font-semibold flex items-center gap-2"><SlidersHorizontal size={16} /> Personalize your dashboard</h2>
        <p class="text-sm text-base-content/60">Choose which cards to show. Options are limited to what your role allows.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {#each choosable as w (w.id)}
            <label class="flex items-center gap-3 p-2 rounded hover:bg-base-300/40 cursor-pointer">
              <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" bind:checked={draft[w.id]} disabled={!w.removable} />
              <span class="text-sm">{LABELS[w.id] ?? w.id}</span>
              {#if !w.removable}<span class="badge badge-ghost badge-xs">always on</span>{/if}
            </label>
          {/each}
        </div>
        <div class="flex items-center justify-between pt-2">
          <button class="btn btn-ghost btn-sm gap-2" onclick={() => mutate('DELETE')} disabled={saving}>
            <RotateCcw size={14} /> Reset
          </button>
          <div class="flex gap-2">
            <button class="btn btn-ghost btn-sm" onclick={() => (editing = false)} disabled={saving}>Cancel</button>
            <button class="btn btn-primary btn-sm" onclick={saveEditing} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="space-y-4">
      {#if has('health')}
        {#if dash.data.health?.ok}
          <div class="alert bg-success/10 border border-success/30">
            <CircleCheck size={20} class="text-success" />
            <span><strong>All systems operational.</strong></span>
          </div>
        {:else}
          <div class="alert bg-warning/10 border border-warning/40">
            <TriangleAlert size={20} class="text-warning" />
            <span><strong>Attention needed.</strong> A core service isn't responding.</span>
          </div>
        {/if}
      {/if}

      {#if has('people') || has('data') || has('activity')}
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {#if has('people')}
            <div class="card bg-base-200"><div class="card-body p-5">
              <div class="flex items-center gap-2 text-base-content/60 text-sm"><Users size={16} /> People</div>
              <p class="text-3xl font-bold tabular-nums">{fmtNum(dash.data.people?.total)}</p>
              <p class="text-xs text-base-content/50">{dash.data.people?.admins ?? 0} with full access</p>
            </div></div>
          {/if}
          {#if has('data')}
            <div class="card bg-base-200"><div class="card-body p-5">
              <div class="flex items-center gap-2 text-base-content/60 text-sm"><Database size={16} /> Records</div>
              <p class="text-3xl font-bold tabular-nums">~{fmtNum(dash.data.data?.records_estimate)}</p>
              <p class="text-xs text-base-content/50">across {dash.data.data?.collections ?? 0} collections</p>
            </div></div>
          {/if}
          {#if has('activity')}
            <div class="card bg-base-200"><div class="card-body p-5">
              <div class="flex items-center gap-2 text-base-content/60 text-sm"><Activity size={16} /> Activity today</div>
              <p class="text-3xl font-bold tabular-nums">{fmtNum(dash.data.activity?.today)}</p>
              <p class="text-xs text-base-content/50">recorded events</p>
            </div></div>
          {/if}
        </div>
      {/if}

      {#if has('activity')}
        <div class="card bg-base-200"><div class="card-body p-5">
          <h2 class="font-semibold flex items-center gap-2"><Activity size={16} /> Recent activity</h2>
          {#if !dash.data.activity?.recent?.length}
            <p class="text-sm text-base-content/50 py-4 text-center">No activity recorded yet.</p>
          {:else}
            <ul class="divide-y divide-base-300/50 -mx-1">
              {#each dash.data.activity.recent as e (e.created_at)}
                <li class="flex items-center justify-between gap-3 py-2.5 px-1">
                  <span class="text-sm">{describe(e)}</span>
                  <span class="text-xs text-base-content/40 whitespace-nowrap tabular-nums">{fmtDateTime(e.created_at)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div></div>
      {/if}

      {#if has('trust')}
        <div class="card bg-base-200 border border-primary/20"><div class="card-body p-5">
          <h2 class="font-semibold flex items-center gap-2 text-primary"><ShieldCheck size={16} /> Your data is protected</h2>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
            <div class="flex items-start gap-2.5"><Lock size={18} class={dash.data.trust?.encryption ? 'text-success mt-0.5' : 'text-base-content/30 mt-0.5'} /><div><p class="text-sm font-medium">Encryption</p><p class="text-xs text-base-content/50">{dash.data.trust?.encryption ? 'Encrypted at rest' : 'Not configured'}</p></div></div>
            <div class="flex items-start gap-2.5"><ScrollText size={18} class="text-success mt-0.5" /><div><p class="text-sm font-medium">Audit trail</p><p class="text-xs text-base-content/50">Every change is logged</p></div></div>
            <div class="flex items-start gap-2.5"><Server size={18} class="text-success mt-0.5" /><div><p class="text-sm font-medium">Self-hosted</p><p class="text-xs text-base-content/50">On your infrastructure</p></div></div>
            <div class="flex items-start gap-2.5"><HardDriveDownload size={18} class={dash.data.trust?.last_backup ? 'text-success mt-0.5' : 'text-warning mt-0.5'} /><div><p class="text-sm font-medium">Backups</p><p class="text-xs text-base-content/50">{dash.data.trust?.last_backup ? `Last: ${fmtDateTime(dash.data.trust.last_backup)}` : 'None yet'}</p></div></div>
          </div>
        </div></div>
      {/if}
    </div>

    {#if dash.personalized}
      <p class="text-xs text-base-content/40 text-center">
        Personalized view. <button class="link" onclick={() => mutate('DELETE')}>Reset to default</button>
      </p>
    {/if}
  {/if}
</div>
