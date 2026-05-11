<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, Play, Trash2, Save, Code, CheckCircle, LoaderCircle } from '@lucide/svelte';

  let functions = $state<any[]>([]);
  let loading = $state(true);
  let selected = $state<any>(null);
  let saving = $state(false);
  let saved = $state(false);
  let invoking = $state(false);
  let invokeInput = $state('{}');
  let invokeResult = $state<any>(null);
  let showCreateModal = $state(false);
  let creating = $state(false);
  let form = $state({ name: '', display_name: '', description: '', http_method: 'POST' });

  const DEFAULT_CODE = `// Edge function — runs inside the Zveltio engine
export default async function handler(ctx) {
  const body = await ctx.request.json().catch(() => ({}));
  return Response.json({ message: "Hello from edge!", input: body });
}
`;

  onMount(loadFunctions);

  async function loadFunctions() {
    loading = true;
    try {
      const data = await api.get<{ functions: any[] }>('/api/edge-functions');
      functions = data.functions ?? [];
      if (functions.length > 0 && !selected) await selectFunction(functions[0]);
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function selectFunction(fn: any) {
    try {
      const data = await api.get<{ function: any }>(`/api/edge-functions/${fn.id}`);
      selected = data.function;
      invokeResult = null;
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function saveCode() {
    if (!selected) return;
    saving = true;
    try {
      await api.patch(`/api/edge-functions/${selected.id}`, { code: selected.code });
      saved = true;
      setTimeout(() => (saved = false), 2000);
    } catch (e: any) { toast.error(e?.message ?? 'Error saving'); }
    finally { saving = false; }
  }

  async function invoke() {
    if (!selected) return;
    invoking = true; invokeResult = null;
    try {
      const data = await api.post<{ result: any }>(`/api/edge-functions/${selected.id}/invoke`, JSON.parse(invokeInput));
      invokeResult = data.result;
    } catch (e: any) { toast.error(e?.message ?? 'Invoke failed'); }
    finally { invoking = false; }
  }

  async function createFunction() {
    if (!form.name || !form.display_name) return;
    creating = true;
    try {
      const data = await api.post<{ function: any }>('/api/edge-functions', { ...form, code: DEFAULT_CODE });
      showCreateModal = false;
      form = { name: '', display_name: '', description: '', http_method: 'POST' };
      await loadFunctions();
      await selectFunction(data.function);
      toast.success('Function created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function deleteFunction(id: string) {
    if (!confirm('Delete this function?')) return;
    try {
      await api.delete(`/api/edge-functions/${id}`);
      selected = null;
      await loadFunctions();
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function toggleActive(fn: any) {
    try {
      await api.patch(`/api/edge-functions/${fn.id}`, { is_active: !fn.is_active });
      await loadFunctions();
      if (selected?.id === fn.id) selected = { ...selected, is_active: !fn.is_active };
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }
</script>

<div class="flex h-[calc(100vh-8rem)] gap-0 border border-base-300 rounded-lg overflow-hidden">
  <div class="w-56 border-r border-base-300 flex flex-col bg-base-100 shrink-0">
    <div class="p-3 border-b border-base-300 flex items-center justify-between">
      <span class="font-semibold text-sm">Edge Functions</span>
      <button class="btn btn-ghost btn-xs" onclick={() => (showCreateModal = true)}><Plus size={14} /></button>
    </div>
    <div class="flex-1 overflow-y-auto">
      {#if loading}
        <div class="flex justify-center py-6"><LoaderCircle size={20} class="animate-spin text-primary" /></div>
      {:else if functions.length === 0}
        <div class="p-4 text-center text-sm text-base-content/40">
          <Code size={28} class="mx-auto mb-2 opacity-30" /> No functions
        </div>
      {:else}
        {#each functions as fn (fn.id)}
          <button
            class="w-full text-left px-3 py-2.5 hover:bg-base-200 transition-colors text-sm {selected?.id === fn.id ? 'bg-primary/10 border-r-2 border-primary' : ''}"
            onclick={() => selectFunction(fn)}
          >
            <div class="flex items-center justify-between gap-1">
              <span class="font-medium truncate">{fn.display_name}</span>
              <span class="badge badge-xs {fn.is_active ? 'badge-success' : 'badge-ghost'} shrink-0">{fn.http_method}</span>
            </div>
            <p class="text-xs text-base-content/40 font-mono mt-0.5 truncate">{fn.path}</p>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  {#if selected}
    <div class="flex-1 flex flex-col min-w-0">
      <div class="border-b border-base-300 px-4 py-2 flex items-center justify-between bg-base-100 gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <h2 class="font-semibold text-sm truncate">{selected.display_name}</h2>
          <span class="badge badge-outline badge-sm font-mono shrink-0">{selected.path}</span>
          <label class="label cursor-pointer gap-1 py-0">
            <span class="label-text text-xs">{selected.is_active ? 'Active' : 'Inactive'}</span>
            <input type="checkbox" class="toggle toggle-xs toggle-success" checked={selected.is_active} onchange={() => toggleActive(selected)} />
          </label>
        </div>
        <div class="flex gap-2 shrink-0">
          <button class="btn btn-ghost btn-sm text-error" onclick={() => deleteFunction(selected.id)}><Trash2 size={14} /></button>
          <button class="btn btn-primary btn-sm gap-1" onclick={saveCode} disabled={saving}>
            {#if saving}<LoaderCircle size={14} class="animate-spin" />{:else if saved}<CheckCircle size={14} />{:else}<Save size={14} />{/if} Save
          </button>
        </div>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <textarea
          class="flex-1 font-mono text-sm p-4 resize-none border-0 outline-none bg-[#1e1e2e] text-[#cdd6f4]"
          bind:value={selected.code}
          spellcheck="false"
        ></textarea>

        <div class="w-64 border-l border-base-300 flex flex-col bg-base-100 shrink-0">
          <div class="p-3 border-b border-base-300 font-medium text-sm">Test Invoke</div>
          <div class="p-3 flex flex-col flex-1 gap-2">
            <label class="label py-0"><span class="label-text text-xs">Request body (JSON)</span></label>
            <textarea class="textarea textarea-sm font-mono flex-1 resize-none text-xs" bind:value={invokeInput} placeholder="{}"></textarea>
            <button class="btn btn-primary btn-sm gap-1 w-full" onclick={invoke} disabled={invoking}>
              {#if invoking}<LoaderCircle size={13} class="animate-spin" />{:else}<Play size={13} />{/if} Run
            </button>
            {#if invokeResult}
              <div>
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-medium">Response</span>
                  <span class="badge badge-xs {invokeResult.status < 400 ? 'badge-success' : 'badge-error'}">{invokeResult.status}</span>
                  <span class="text-xs text-base-content/40">{invokeResult.duration_ms}ms</span>
                </div>
                <pre class="text-xs font-mono bg-base-200 rounded p-2 overflow-auto max-h-32">{invokeResult.body}</pre>
                {#if invokeResult.logs?.length}
                  <div class="mt-1"><p class="text-xs font-medium mb-0.5">Console</p>
                  {#each invokeResult.logs as log}<p class="text-xs font-mono text-base-content/60">{log}</p>{/each}</div>
                {/if}
                {#if invokeResult.error}<p class="text-xs text-error mt-1">{invokeResult.error}</p>{/if}
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {:else if !loading}
    <div class="flex-1 flex items-center justify-center text-base-content/40">
      <div class="text-center">
        <Code size={48} class="mx-auto mb-3 opacity-20" />
        <p class="text-sm">Select a function or create one</p>
        <button class="btn btn-primary btn-sm mt-3 gap-1" onclick={() => (showCreateModal = true)}><Plus size={14} /> New Function</button>
      </div>
    </div>
  {/if}
</div>

{#if showCreateModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New Edge Function</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Name (URL-safe)</span></label>
          <input class="input input-sm font-mono" bind:value={form.name} placeholder="my-function" />
          <label class="label py-0"><span class="label-text-alt text-xs">Mounted at /api/fn/{form.name || '…'}</span></label>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Display name</span></label><input class="input input-sm" bind:value={form.display_name} placeholder="My Function" /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">HTTP method</span></label>
          <select class="select select-sm" bind:value={form.http_method}>
            <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>ANY</option>
          </select>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={createFunction} disabled={creating || !form.name || !form.display_name}>
          {#if creating}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </div>
{/if}
