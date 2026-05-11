<script lang="ts">
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
      if (tab === 'requests') { const r = await api.get<{ data: any[] }>('/api/gdpr/access-requests'); requests = r.data ?? []; }
      else if (tab === 'breaches') { const r = await api.get<{ data: any[] }>('/api/gdpr/breach-incidents'); breaches = r.data ?? []; }
      else if (tab === 'consents') { const r = await api.get<{ data: any[] }>('/api/gdpr/consents'); consents = r.data ?? []; }
      else { const r = await api.get<{ data: any[] }>('/api/gdpr/processing-records'); records = r.data ?? []; }
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function fulfill(id: string) {
    try {
      await api.post(`/api/gdpr/access-requests/${id}/fulfill`, {});
      const r = await api.get<{ data: any[] }>('/api/gdpr/access-requests');
      requests = r.data ?? [];
      toast.success('Request fulfilled.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function reject(id: string) {
    try {
      await api.post(`/api/gdpr/access-requests/${id}/reject`, {});
      const r = await api.get<{ data: any[] }>('/api/gdpr/access-requests');
      requests = r.data ?? [];
      toast.success('Request rejected.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => { tab; loadTab(); });
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><Shield size={20} /> GDPR Compliance</h1>
    <p class="text-sm text-base-content/50">Manage data subject requests, breaches, consents, and processing records</p>
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'requests' ? 'tab-active' : ''}" onclick={() => (tab = 'requests')}>
      <Users size={13} class="mr-1.5" /> Access requests
    </button>
    <button class="tab {tab === 'breaches' ? 'tab-active' : ''}" onclick={() => (tab = 'breaches')}>
      <FileWarning size={13} class="mr-1.5" /> Breaches
    </button>
    <button class="tab {tab === 'consents' ? 'tab-active' : ''}" onclick={() => (tab = 'consents')}>Consents</button>
    <button class="tab {tab === 'records' ? 'tab-active' : ''}" onclick={() => (tab = 'records')}>
      <Database size={13} class="mr-1.5" /> Processing records
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'requests'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Type</th><th>Subject</th><th>Requested</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#if requests.length === 0}
            <tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No requests.</td></tr>
          {:else}
            {#each requests as r (r.id)}
              <tr class="hover">
                <td><span class="badge badge-sm">{r.request_type}</span></td>
                <td class="text-sm">{r.subject_email ?? r.subject_id}</td>
                <td class="text-xs text-base-content/50">{r.created_at?.slice(0, 10)}</td>
                <td><span class="badge badge-sm">{r.status}</span></td>
                <td>
                  {#if r.status === 'pending'}
                    <button class="btn btn-ghost btn-xs" onclick={() => fulfill(r.id)}>Fulfill</button>
                    <button class="btn btn-ghost btn-xs" onclick={() => reject(r.id)}>Reject</button>
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
        <thead><tr><th>Date</th><th>Description</th><th>Severity</th><th>Affected</th><th>Notified DPA</th></tr></thead>
        <tbody>
          {#if breaches.length === 0}
            <tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No breach incidents recorded.</td></tr>
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
        <thead><tr><th>Subject</th><th>Purpose</th><th>Granted</th><th>Withdrawn</th></tr></thead>
        <tbody>
          {#if consents.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No consents recorded.</td></tr>
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
        <thead><tr><th>Activity</th><th>Lawful basis</th><th>Categories</th><th>Retention</th></tr></thead>
        <tbody>
          {#if records.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No records of processing yet.</td></tr>
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
</div>
