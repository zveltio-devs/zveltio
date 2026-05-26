<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { Shield, FileWarning, Users, Database, LoaderCircle } from '@lucide/svelte';

let tab = $state<'requests' | 'breaches' | 'consents' | 'records'>('requests');
let requests = $state<any[]>([]);
let breaches = $state<any[]>([]);
let consents = $state<any[]>([]);
let records = $state<any[]>([]);
let loading = $state(true);

async function loadTab() {
  loading = true;
  try {
    if (tab === 'requests') {
      const r = await api.get<{ data: any[] }>('/ext/compliance/gdpr/access-requests');
      requests = r.data ?? [];
    } else if (tab === 'breaches') {
      const r = await api.get<{ data: any[] }>('/ext/compliance/gdpr/breach-incidents');
      breaches = r.data ?? [];
    } else if (tab === 'consents') {
      const r = await api.get<{ data: any[] }>('/ext/compliance/gdpr/consents');
      consents = r.data ?? [];
    } else {
      const r = await api.get<{ data: any[] }>('/ext/compliance/gdpr/processing-records');
      records = r.data ?? [];
    }
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function fulfill(id: string) {
  try {
    await api.post(`/ext/compliance/gdpr/access-requests/${id}/fulfill`, {});
    const r = await api.get<{ data: any[] }>('/ext/compliance/gdpr/access-requests');
    requests = r.data ?? [];
    toast.success(m['compliance.gdpr.toast.fulfilled']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function reject(id: string) {
  try {
    await api.post(`/ext/compliance/gdpr/access-requests/${id}/reject`, {});
    const r = await api.get<{ data: any[] }>('/ext/compliance/gdpr/access-requests');
    requests = r.data ?? [];
    toast.success(m['compliance.gdpr.toast.rejected']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

$effect(() => {
  tab;
  loadTab();
});
</script>

<ExtensionPageShell title={m['compliance.gdpr.title']()} subtitle={m['compliance.gdpr.subtitle']()}>
<div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'requests' ? 'tab-active' : ''}" onclick={() => (tab = 'requests')}>
      <Users size={13} class="mr-1.5" />{m['compliance.gdpr.tab.requests']()}
    </button>
    <button class="tab {tab === 'breaches' ? 'tab-active' : ''}" onclick={() => (tab = 'breaches')}>
      <FileWarning size={13} class="mr-1.5" />{m['compliance.gdpr.tab.breaches']()}
    </button>
    <button class="tab {tab === 'consents' ? 'tab-active' : ''}" onclick={() => (tab = 'consents')}>{m['compliance.gdpr.tab.consents']()}</button>
    <button class="tab {tab === 'records' ? 'tab-active' : ''}" onclick={() => (tab = 'records')}>
      <Database size={13} class="mr-1.5" />{m['compliance.gdpr.tab.records']()}
    </button>
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'requests'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.type']()}</th><th>{m['common.col.subject']()}</th><th>{m['compliance.gdpr.col.requested']()}</th><th>{m['common.col.status']()}</th><th></th></tr></thead>
        <tbody>
          {#if requests.length === 0}
            <tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">{m['hr.leave.emptyRequests']()}</td></tr>
          {:else}
            {#each requests as r (r.id)}
              <tr class="hover">
                <td><span class="badge badge-sm">{r.request_type}</span></td>
                <td class="text-sm">{r.subject_email ?? r.subject_id}</td>
                <td class="text-xs text-base-content/50">{r.created_at?.slice(0, 10)}</td>
                <td><span class="badge badge-sm">{r.status}</span></td>
                <td>
                  {#if r.status === 'pending'}
                    <button class="btn btn-ghost btn-xs" onclick={() => fulfill(r.id)}>{m['compliance.gdpr.btn.fulfill']()}</button>
                    <button class="btn btn-ghost btn-xs" onclick={() => reject(r.id)}>{m['common.reject']()}</button>
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'breaches'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.date']()}</th><th>{m['common.col.description']()}</th><th>{m['compliance.gdpr.col.severity']()}</th><th>{m['compliance.gdpr.col.affected']()}</th><th>{m['compliance.gdpr.col.notifiedDpa']()}</th></tr></thead>
        <tbody>
          {#if breaches.length === 0}
            <tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">{m['compliance.gdpr.ui.no_breach_incidents_recorded']()}</td></tr>
          {:else}
            {#each breaches as b (b.id)}
              <tr class="hover">
                <td class="text-xs">{b.detected_at?.slice(0, 10)}</td>
                <td class="max-w-xs truncate text-sm">{b.description}</td>
                <td><span class="badge badge-error badge-sm">{b.severity}</span></td>
                <td class="text-sm">{b.affected_count ?? '?'}</td>
                <td>{b.notified_dpa_at ? '✓' : '—'}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'consents'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.subject']()}</th><th>{m['compliance.gdpr.col.purpose']()}</th><th>{m['compliance.gdpr.col.granted']()}</th><th>{m['compliance.gdpr.col.withdrawn']()}</th></tr></thead>
        <tbody>
          {#if consents.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['compliance.gdpr.ui.no_consents_recorded']()}</td></tr>
          {:else}
            {#each consents as c (c.id)}
              <tr class="hover">
                <td class="text-sm">{c.subject_id}</td>
                <td class="text-sm">{c.purpose}</td>
                <td class="text-xs">{c.granted_at?.slice(0, 10)}</td>
                <td class="text-xs">{c.withdrawn_at?.slice(0, 10) ?? '—'}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['compliance.gdpr.col.activity']()}</th><th>{m['compliance.gdpr.col.lawfulBasis']()}</th><th>{m['compliance.gdpr.col.categories']()}</th><th>{m['compliance.gdpr.col.retention']()}</th></tr></thead>
        <tbody>
          {#if records.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['compliance.gdpr.ui.no_records_of_processing_yet']()}</td></tr>
          {:else}
            {#each records as r (r.id)}
              <tr class="hover">
                <td class="text-sm">{r.activity_name}</td>
                <td class="text-sm">{r.lawful_basis}</td>
                <td class="text-xs">{(r.data_categories ?? []).join(', ')}</td>
                <td class="text-sm">{r.retention_period ?? '—'}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</ExtensionPageShell>
