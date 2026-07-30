<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
    import { onMount } from 'svelte';
  import { DatabaseZap, Plus, X, ScanLine, Play } from '@lucide/svelte';
  import { api as zApi } from '$lib/api.js';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

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
        askConfirm(m['developer.byod.confirmDelete'](), () => deleteProfileConfirmed(id));
  }
  async function deleteProfileConfirmed(id: string) {
    try { await api(`/api/byod/scan-profiles/${id}`, { method: 'DELETE' }); await loadProfiles(); }
    catch (e: any) { error = e.message; }
  }


  $effect(() => { tab === 'profiles' ? loadProfiles() : loadHistory(); });
  onMount(loadProfiles);
</script>

<ExtensionPageShell title={m['developer.byod.title']()} subtitle={m['developer.byod.subtitle']()}>
{#if error}<div class="alert alert-error">{error}</div>{/if}
  <p class="text-sm text-base-content/70">{m['developer.byod.intro']()}</p>

  <div role="tablist" class="tabs tabs-bordered">
    <button role="tab" class:tab-active={tab === 'profiles'} class="tab" onclick={() => (tab = 'profiles')}>{m['developer.byod.tab.profiles']()}</button>
    <button role="tab" class:tab-active={tab === 'history'} class="tab" onclick={() => (tab = 'history')}>{m['developer.byod.tab.history']()}</button>
</div>

{#if tab === 'profiles'}
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.name']()}</th><th>{m['developer.byod.col.schema']()}</th><th>{m['developer.byod.col.lastScan']()}</th><th>{m['developer.byod.col.tablesFound']()}</th><th></th></tr></thead>
        <tbody>
          {#if profiles.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/60">{m['developer.byod.ui.no_profiles_create_one_to_scan_an_external_db']()}</td></tr>
          {:else}{#each profiles as p (p.id)}
            <tr>
              <td>{p.name}</td><td class="font-mono text-xs">{p.schema}</td>
              <td>{p.last_scanned_at?.slice(0, 16).replace('T', ' ') ?? m['developer.byod.never']()}</td>
              <td>{p.tables_found ?? '—'}</td>
              <td>
                <button class="btn btn-ghost btn-xs gap-1" disabled={scanning === p.id} onclick={() => runScan(p.id)}>
                  <Play class="h-3 w-3" /> {scanning === p.id ? m['developer.byod.btn.scanning']() : m['developer.byod.btn.scan']()}
                </button>
                <button class="btn btn-ghost btn-xs" onclick={() => deleteProfile(p.id)}>{m['common.delete']()}</button>
              </td>
            </tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
      <table class="table table-sm">
        <thead><tr><th>{m['developer.byod.col.profile']()}</th><th>{m['developer.byod.col.started']()}</th><th>{m['common.col.duration']()}</th><th>{m['developer.byod.col.tables']()}</th><th>{m['common.col.status']()}</th></tr></thead>
        <tbody>
          {#if history.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/60">{m['analytics.quality.ui.no_scans_yet']()}</td></tr>
          {:else}{#each history as h (h.id)}
            <tr><td>{h.profile_name ?? h.profile_id}</td><td>{h.started_at?.slice(0, 16).replace('T', ' ')}</td><td>{h.duration_ms ?? '—'} ms</td><td>{h.tables_count ?? 0}</td><td><span class="badge badge-sm">{h.status}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>

{#if showForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-lg">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">{m['developer.byod.ui.new_connection_profile']()}</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div><label class="label label-text">{m['developer.byod.form.name']()}</label><input class="input input-bordered w-full" bind:value={form.name} /></div>
        <div><label class="label label-text">{m['developer.byod.form.connectionString']()}</label><input type="password" class="input input-bordered w-full font-mono" bind:value={form.connection_string} placeholder={m['developer.byod.ui.postgresql_user_pass_host_5432_db']()} /></div>
        <div><label class="label label-text">{m['developer.byod.form.schema']()}</label><input class="input input-bordered w-full font-mono" bind:value={form.schema} /></div>
        <div><label class="label label-text">{m['developer.byod.form.includePatterns']()}</label><input class="input input-bordered w-full font-mono text-xs" bind:value={form.include_patterns} placeholder={m['developer.byod.ui.public_users_public_orders']()} /></div>
        <div><label class="label label-text">{m['developer.byod.form.excludePatterns']()}</label><input class="input input-bordered w-full font-mono text-xs" bind:value={form.exclude_patterns} /></div>
      </div>
      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showForm = false)}>{m['common.cancel']()}</button><button class="btn btn-primary" disabled={saving || !form.name || !form.connection_string} onclick={createProfile}>{saving ? m['developer.byod.saving']() : m['common.create']()}</button></div>
    </div>
  </div>
{/if}
