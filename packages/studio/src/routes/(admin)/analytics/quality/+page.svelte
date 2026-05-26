<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { ScanSearch, Play, AlertTriangle, LoaderCircle } from '@lucide/svelte';

let scans = $state<any[]>([]);
let issues = $state<any[]>([]);
let collections = $state<any[]>([]);
let selectedCollection = $state('');
let scanning = $state(false);
let loading = $state(true);

async function loadAll() {
  loading = true;
  try {
    const [s, c] = await Promise.all([
      api.get<{ data: any[] }>('/ext/analytics/quality/scans'),
      api.get<{ collections: any[] }>('/api/collections').catch(() => ({ collections: [] })),
    ]);
    scans = s.data ?? [];
    collections = c.collections ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function runScan() {
  if (!selectedCollection) return;
  scanning = true;
  try {
    const r = await api.post<{ issues: any[] }>('/ext/analytics/quality/scans', {
      collection: selectedCollection,
    });
    issues = r.issues ?? [];
    await loadAll();
  } catch (e: any) {
    toast.error(e?.message ?? 'Scan failed');
  } finally {
    scanning = false;
  }
}

async function viewIssues(scanId: string) {
  try {
    const r = await api.get<{ data: any[] }>(`/ext/analytics/quality/scans/${scanId}/issues`);
    issues = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

onMount(loadAll);

function severityBadge(s: string) {
  return (
    ({ critical: 'badge-error', high: 'badge-warning', info: 'badge-info' } as any)[s] ??
    'badge-ghost'
  );
}
</script>

<ExtensionPageShell title={m['analytics.quality.title']()} subtitle={m['analytics.quality.subtitle']()}>
{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4">
        <div class="flex gap-2 items-end">
          <div class="flex-1 form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['analytics.quality.ui.collection']()}</span></label>
            <select class="select select-sm" bind:value={selectedCollection}>
              <option value="">{m['analytics.quality.ui.select_collection']()}</option>
              {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
            </select>
          </div>
          <button class="btn btn-primary btn-sm gap-2" disabled={scanning || !selectedCollection} onclick={runScan}>
            {#if scanning}<LoaderCircle size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
            {scanning ? 'Scanning…' : 'Run scan'}
          </button>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 font-medium text-sm border-b border-base-300">{m['analytics.quality.tab.history']()}</div>
          <table class="table table-sm">
            <thead><tr><th>{m['common.col.collection']()}</th><th>{m['common.col.date']()}</th><th>{m['analytics.quality.tab.issues']()}</th><th></th></tr></thead>
            <tbody>
              {#if scans.length === 0}
                <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['analytics.quality.ui.no_scans_yet']()}</td></tr>
              {:else}
                {#each scans as s (s.id)}
                  <tr class="hover">
                    <td class="text-sm">{s.collection}</td>
                    <td class="text-xs text-base-content/50">{s.created_at?.slice(0, 16).replace('T', ' ')}</td>
                    <td><span class="badge badge-sm">{s.issue_count ?? 0}</span></td>
                    <td><button class="btn btn-ghost btn-xs" onclick={() => viewIssues(s.id)}>{m['common.view']()}</button></td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 font-medium text-sm border-b border-base-300 flex items-center gap-2"><AlertTriangle size={14} /> {m['analytics.quality.tab.issues']()}</div>
          <table class="table table-sm">
            <thead><tr><th>{m['analytics.quality.col.severity']()}</th><th>{m['common.col.type']()}</th><th>{m['common.col.field']()}</th><th>{m['common.col.description']()}</th></tr></thead>
            <tbody>
              {#if issues.length === 0}
                <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['analytics.quality.ui.no_issues_to_show_run_a_scan']()}</td></tr>
              {:else}
                {#each issues as i (i.id ?? `${i.field_name}-${i.issue_type}`)}
                  <tr class="hover">
                    <td><span class="badge {severityBadge(i.severity)} badge-sm">{i.severity}</span></td>
                    <td class="text-xs">{i.issue_type}</td>
                    <td class="font-mono text-xs">{i.field_name ?? '—'}</td>
                    <td class="max-w-xs truncate text-xs">{i.description}</td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}
</ExtensionPageShell>
