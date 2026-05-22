<script lang="ts">
  import { onMount } from 'svelte';
  import { DatabaseZap, Plus, X, ScanLine, Play } from '@lucide/svelte';
  import { api as zApi } from '$lib/api.js';

  let tab = $state<'profiles' | 'history'>('profiles');
  let profiles = $state<any[]>([]);
  let history = $state<any[]>([]);
  let error = $state('');
  let scanning = $state<string | null>(null);

  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    name: '',
    connection_string: '',
    schema: 'public',
    include_patterns: '',
    exclude_patterns: 'pg_*,information_schema.*',
  });

  // Local wrapper around the shared $lib/api client (renamed import to
  // `zApi` to avoid colliding with this helper's name). Routes credentials
  // through the centralised module instead of re-implementing the cookie
  // and base-URL logic per page.
  async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await zApi.fetch(path, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json as T;
  }
  async function loadProfiles() { try { const r = await api('/api/byod/scan-profiles'); profiles = r.data ?? []; } catch (e: any) { error = e.message; } }
  async function loadHistory() { try { const r = await api('/api/byod/scan-history?limit=50'); history = r.data ?? []; } catch (e: any) { error = e.message; } }

  async function createProfile() {
    saving = true; error = '';
    try {
      await api('/api/byod/scan-profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          include_patterns: form.include_patterns.split(',').map((s) => s.trim()).filter(Boolean),
          exclude_patterns: form.exclude_patterns.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      showForm = false;
      form = { name: '', connection_string: '', schema: 'public', include_patterns: '', exclude_patterns: 'pg_*,information_schema.*' };
      await loadProfiles();
    } catch (e: any) { error = e.message; } finally { saving = false; }
  }

  async function runScan(id: string) {
    scanning = id; error = '';
    try {
      await api(`/api/byod/scan-profiles/${id}/scan`, { method: 'POST' });
      tab = 'history';
      await loadHistory();
    } catch (e: any) { error = e.message; } finally { scanning = null; }
  }

  async function deleteProfile(id: string) {
    if (!confirm('Delete profile?')) return;
    try { await api(`/api/byod/scan-profiles/${id}`, { method: 'DELETE' }); await loadProfiles(); }
    catch (e: any) { error = e.message; }
  }

  $effect(() => { tab === 'profiles' ? loadProfiles() : loadHistory(); });
  onMount(loadProfiles);
</script>

<div class="p-6 space-y-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold flex items-center gap-2"><DatabaseZap class="h-6 w-6" /> Bring Your Own Database</h1>
    {#if tab === 'profiles'}<button class="btn btn-primary btn-sm gap-2" onclick={() => (showForm = true)}><Plus class="h-4 w-4" /> New profile</button>{/if}
  </header>
  {#if error}<div class="alert alert-error">{error}</div>{/if}
  <p class="text-sm text-base-content/70">Connect to an external PostgreSQL database, scan its schema, and surface tables as virtual collections in Zveltio.</p>

  <div role="tablist" class="tabs tabs-bordered">
    <button role="tab" class:tab-active={tab === 'profiles'} class="tab" onclick={() => (tab = 'profiles')}>Connection profiles</button>
    <button role="tab" class:tab-active={tab === 'history'} class="tab" onclick={() => (tab = 'history')}>Scan history</button>
  </div>

  {#if tab === 'profiles'}
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>Name</th><th>Schema</th><th>Last scan</th><th>Tables found</th><th></th></tr></thead>
        <tbody>
          {#if profiles.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/60">No profiles. Create one to scan an external DB.</td></tr>
          {:else}{#each profiles as p (p.id)}
            <tr>
              <td>{p.name}</td><td class="font-mono text-xs">{p.schema}</td>
              <td>{p.last_scanned_at?.slice(0, 16).replace('T', ' ') ?? 'never'}</td>
              <td>{p.tables_found ?? '—'}</td>
              <td>
                <button class="btn btn-ghost btn-xs gap-1" disabled={scanning === p.id} onclick={() => runScan(p.id)}>
                  <Play class="h-3 w-3" /> {scanning === p.id ? 'Scanning…' : 'Scan'}
                </button>
                <button class="btn btn-ghost btn-xs" onclick={() => deleteProfile(p.id)}>Delete</button>
              </td>
            </tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>Profile</th><th>Started</th><th>Duration</th><th>Tables</th><th>Status</th></tr></thead>
        <tbody>
          {#if history.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/60">No scans yet.</td></tr>
          {:else}{#each history as h (h.id)}
            <tr><td>{h.profile_name ?? h.profile_id}</td><td>{h.started_at?.slice(0, 16).replace('T', ' ')}</td><td>{h.duration_ms ?? '—'} ms</td><td>{h.tables_count ?? 0}</td><td><span class="badge badge-sm">{h.status}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-lg">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">New connection profile</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div><label class="label label-text">Name</label><input class="input input-bordered w-full" bind:value={form.name} /></div>
        <div><label class="label label-text">Connection string</label><input type="password" class="input input-bordered w-full font-mono" bind:value={form.connection_string} placeholder="postgresql://user:pass@host:5432/db" /></div>
        <div><label class="label label-text">Schema</label><input class="input input-bordered w-full font-mono" bind:value={form.schema} /></div>
        <div><label class="label label-text">Include patterns (comma-separated)</label><input class="input input-bordered w-full font-mono text-xs" bind:value={form.include_patterns} placeholder="public.users, public.orders*" /></div>
        <div><label class="label label-text">Exclude patterns</label><input class="input input-bordered w-full font-mono text-xs" bind:value={form.exclude_patterns} /></div>
      </div>
      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showForm = false)}>Cancel</button><button class="btn btn-primary" disabled={saving || !form.name || !form.connection_string} onclick={createProfile}>{saving ? 'Saving…' : 'Create'}</button></div>
    </div>
  </div>
{/if}
