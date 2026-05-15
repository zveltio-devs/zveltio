<script lang="ts">
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Network, Play, Save, LoaderCircle } from '@lucide/svelte';

  let tab = $state<'playground' | 'logs' | 'persisted' | 'policies'>('playground');
  let logs = $state<any[]>([]);
  let persisted = $state<any[]>([]);
  let policies = $state<any[]>([]);
  let loading = $state(false);

  let queryText = $state('{\n  collections {\n    name\n    display_name\n  }\n}');
  let queryResult = $state('');
  let running = $state(false);

  async function runQuery() {
    running = true; queryResult = '';
    try {
      const res = await api.post<object>('/ext/developer/graphql', { query: queryText });
      queryResult = JSON.stringify(res, null, 2);
    } catch (e: any) { toast.error(e?.message ?? 'Query failed'); queryResult = ''; }
    finally { running = false; }
  }

  async function loadLogs() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/developer/graphql/operations?limit=100'); logs = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }
  async function loadPersisted() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/developer/graphql/persisted'); persisted = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }
  async function loadPolicies() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/developer/graphql/field-policies'); policies = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  $effect(() => {
    if (tab === 'logs') loadLogs();
    else if (tab === 'persisted') loadPersisted();
    else if (tab === 'policies') loadPolicies();
  });
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><Network size={20} /> GraphQL</h1>
    <p class="text-sm text-base-content/50">Playground, operation logs, and field policies</p>
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'playground' ? 'tab-active' : ''}" onclick={() => (tab = 'playground')}><Play size={13} class="mr-1.5" /> Playground</button>
    <button class="tab {tab === 'logs' ? 'tab-active' : ''}" onclick={() => (tab = 'logs')}>Operation logs</button>
    <button class="tab {tab === 'persisted' ? 'tab-active' : ''}" onclick={() => (tab = 'persisted')}><Save size={13} class="mr-1.5" /> Persisted queries</button>
    <button class="tab {tab === 'policies' ? 'tab-active' : ''}" onclick={() => (tab = 'policies')}>Field policies</button>
  </div>

  {#if tab === 'playground'}
    <div class="grid grid-cols-2 gap-4 h-[60vh]">
      <div class="card bg-base-200 border border-base-300 flex flex-col">
        <div class="p-3 border-b border-base-300 flex items-center justify-between">
          <span class="font-medium text-sm">Query</span>
          <button class="btn btn-primary btn-sm gap-1" disabled={running} onclick={runQuery}>
            {#if running}<LoaderCircle size={13} class="animate-spin" />{:else}<Play size={13} />{/if} Run
          </button>
        </div>
        <textarea class="flex-1 font-mono text-sm p-3 resize-none bg-transparent border-0 outline-none" bind:value={queryText}></textarea>
      </div>
      <div class="card bg-base-200 border border-base-300 flex flex-col">
        <div class="p-3 border-b border-base-300 font-medium text-sm">Response</div>
        <pre class="flex-1 p-3 overflow-auto font-mono text-xs">{queryResult || '(run a query to see output)'}</pre>
      </div>
    </div>
  {:else if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'logs'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Time</th><th>Operation</th><th>User</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody>
          {#if logs.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No operations logged.</td></tr>
          {:else}{#each logs as l (l.id)}
            <tr class="hover"><td class="text-xs">{l.created_at?.slice(0, 19).replace('T', ' ')}</td><td class="font-mono text-xs max-w-xs truncate">{l.operation_name ?? l.query_preview}</td><td class="text-sm">{l.user_id ?? 'anon'}</td><td class="text-sm">{l.duration_ms ?? '—'} ms</td><td><span class="badge badge-sm {l.error ? 'badge-error' : 'badge-success'}">{l.error ? 'error' : 'ok'}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'persisted'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>ID</th><th>Operation</th><th>Created</th></tr></thead>
        <tbody>
          {#if persisted.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">No persisted queries.</td></tr>
          {:else}{#each persisted as p (p.id)}
            <tr class="hover"><td class="font-mono text-xs">{p.id?.slice(0, 16)}…</td><td class="font-mono text-xs max-w-md truncate">{p.operation_name ?? p.query_preview}</td><td class="text-xs">{p.created_at?.slice(0, 10)}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Type</th><th>Field</th><th>Roles</th><th>Mode</th></tr></thead>
        <tbody>
          {#if policies.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No field policies — all fields readable.</td></tr>
          {:else}{#each policies as p (p.id)}
            <tr class="hover"><td class="font-mono text-sm">{p.type_name}</td><td class="font-mono text-sm">{p.field_name}</td><td class="text-xs">{(p.allowed_roles ?? []).join(', ') || '—'}</td><td><span class="badge badge-sm">{p.mode ?? 'allow'}</span></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
