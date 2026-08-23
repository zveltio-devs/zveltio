<script lang="ts">
/**
 * GraphQL playground — POST /ext/developer/graphql (not stale /api/graphql).
 */
import { Play, RefreshCw } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';

const ENDPOINT = '/ext/developer/graphql';

let query = $state(`query {
  __typename
}`);
let variables = $state('{}');
let result = $state('');
let running = $state(false);
let status = $state<number | null>(null);

async function run(): Promise<void> {
  running = true;
  status = null;
  try {
    let vars: Record<string, unknown> = {};
    try {
      vars = variables.trim() ? JSON.parse(variables) : {};
    } catch {
      toast.error('Variables must be valid JSON');
      return;
    }
    const res = await api.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: vars }),
    });
    status = res.status;
    const body = await res.json().catch(() => ({}));
    result = JSON.stringify(body, null, 2);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Request failed');
  } finally {
    running = false;
  }
}

async function refreshSchema(): Promise<void> {
  try {
    await api.post(`${ENDPOINT}/refresh-schema`, {});
    toast.success('Schema cache refreshed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Refresh failed');
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    void run();
  }
}
</script>

<div class="flex flex-col h-[calc(100vh-8rem)] min-h-[28rem] gap-3">
  <div class="flex items-center gap-2 flex-wrap">
    <h1 class="font-semibold text-lg flex-1">GraphQL Playground</h1>
    <code class="text-xs opacity-50 font-mono">{ENDPOINT}</code>
    <button type="button" class="btn btn-ghost btn-sm gap-1" onclick={() => void refreshSchema()}>
      <RefreshCw size={14} /> Schema
    </button>
    <button type="button" class="btn btn-primary btn-sm gap-1" disabled={running} onclick={() => void run()}>
      <Play size={14} />
      {running ? 'Running…' : 'Run'}
    </button>
    {#if status !== null}
      <span class="badge badge-sm {status < 400 ? 'badge-success' : 'badge-error'}">{status}</span>
    {/if}
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
    <div class="flex flex-col gap-2 min-h-0">
      <label class="text-xs opacity-60" for="gql-query">Query</label>
      <textarea
        id="gql-query"
        class="textarea textarea-bordered font-mono text-xs flex-1 min-h-[12rem]"
        bind:value={query}
        onkeydown={onKeydown}
      ></textarea>
      <label class="text-xs opacity-60" for="gql-vars">Variables (JSON)</label>
      <textarea
        id="gql-vars"
        class="textarea textarea-bordered font-mono text-xs h-24"
        bind:value={variables}
      ></textarea>
    </div>
    <div class="flex flex-col min-h-0">
      <label class="text-xs opacity-60 mb-2" for="gql-out">Response</label>
      <pre
        id="gql-out"
        class="flex-1 overflow-auto rounded-lg border border-base-300 bg-base-200/50 p-3 text-xs font-mono whitespace-pre-wrap"
      >{result || '—'}</pre>
    </div>
  </div>
  <p class="text-xs opacity-50">⌘/Ctrl+Enter to run. Introspect with a standard GraphQL introspection query.</p>
</div>
