<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, Play, Trash2, Save, Code, CheckCircle } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

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

 onMount(async () => {
 await loadFunctions();
 });

 async function loadFunctions() {
 loading = true;
 try {
 const res = await fetch(`${engineUrl}/api/edge-functions`, { credentials: 'include' });
 const data = await res.json();
 functions = data.functions || [];
 if (functions.length > 0 && !selected) {
 await selectFunction(functions[0]);
 }
 } finally {
 loading = false;
 }
 }

 async function selectFunction(fn: any) {
 const res = await fetch(`${engineUrl}/api/edge-functions/${fn.id}`, { credentials: 'include' });
 const data = await res.json();
 selected = data.function;
 invokeResult = null;
 }

 async function saveCode() {
 if (!selected) return;
 saving = true;
 try {
 await fetch(`${engineUrl}/api/edge-functions/${selected.id}`, {
 method: 'PATCH',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ code: selected.code }),
 });
 saved = true;
 setTimeout(() => (saved = false), 2000);
 } finally {
 saving = false;
 }
 }

 async function invoke() {
 if (!selected) return;
 invoking = true;
 invokeResult = null;
 try {
 const res = await fetch(`${engineUrl}/api/edge-functions/${selected.id}/invoke`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: invokeInput,
 });
 const data = await res.json();
 invokeResult = data.result;
 } finally {
 invoking = false;
 }
 }

 async function createFunction() {
 if (!form.name || !form.display_name) return;
 creating = true;
 try {
 const res = await fetch(`${engineUrl}/api/edge-functions`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ ...form, code: DEFAULT_CODE }),
 });
 const data = await res.json();
 showCreateModal = false;
 form = { name: '', display_name: '', description: '', http_method: 'POST' };
 await loadFunctions();
 await selectFunction(data.function);
 } finally {
 creating = false;
 }
 }

 async function deleteFunction(id: string) {
 if (!confirm('Delete this function?')) return;
 await fetch(`${engineUrl}/api/edge-functions/${id}`, { method: 'DELETE', credentials: 'include' });
 selected = null;
 await loadFunctions();
 }

 async function toggleActive(fn: any) {
 await fetch(`${engineUrl}/api/edge-functions/${fn.id}`, {
 method: 'PATCH',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ is_active: !fn.is_active }),
 });
 await loadFunctions();
 if (selected?.id === fn.id) selected.is_active = !fn.is_active;
 }
</script>

<div class="flex h-[calc(100vh-4rem)]">
 <!-- Left sidebar: function list -->
 <div class="w-60 border-r border-base-300 flex flex-col bg-base-100">
 <div class="p-3 border-b border-base-300 flex items-center justify-between">
 <span class="font-semibold text-sm">Edge Functions</span>
 <button class="btn btn-ghost btn-xs" onclick={() => (showCreateModal = true)}>
 <Plus size={14} />
 </button>
 </div>

 <div class="flex-1 overflow-y-auto">
 {#if loading}
 <div class="flex justify-center py-6"><span class="loading loading-spinner loading-sm"></span></div>
 {:else if functions.length === 0}
 <div class="p-4 text-center text-sm text-base-content/40">
 <Code size={32} class="mx-auto mb-2 opacity-30" />
 No functions yet
 </div>
 {:else}
 {#each functions as fn}
 <button
 class="w-full text-left px-3 py-2.5 hover:bg-base-200 transition-colors {selected?.id === fn.id ? 'bg-primary/10 border-r-2 border-primary' : ''}"
 onclick={() => selectFunction(fn)}
 >
 <div class="flex items-center justify-between">
 <span class="font-medium text-sm truncate">{fn.display_name}</span>
 <span class="badge badge-xs {fn.is_active ? 'badge-success' : 'badge-ghost'}">{fn.http_method}</span>
 </div>
 <p class="text-xs text-base-content/40 font-mono mt-0.5 truncate">{fn.path}</p>
 </button>
 {/each}
 {/if}
 </div>
 </div>

 <!-- Right: editor -->
 {#if selected}
 <div class="flex-1 flex flex-col">
 <!-- Toolbar -->
 <div class="border-b border-base-300 px-4 py-2 flex items-center justify-between bg-base-100">
 <div class="flex items-center gap-3">
 <h2 class="font-semibold">{selected.display_name}</h2>
 <span class="badge badge-outline badge-sm font-mono">{selected.path}</span>
 <label class="label cursor-pointer gap-1">
 <span class="label-text text-xs">{selected.is_active ? 'Active' : 'Inactive'}</span>
 <input
 type="checkbox"
 class="toggle toggle-xs toggle-success"
 checked={selected.is_active}
 onchange={() => toggleActive(selected)}
 />
 </label>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm text-error" onclick={() => deleteFunction(selected.id)}>
 <Trash2 size={14} />
 </button>
 <button class="btn btn-primary btn-sm gap-1" onclick={saveCode} disabled={saving}>
 {#if saving}
 <span class="loading loading-spinner loading-xs"></span>
 {:else if saved}
 <CheckCircle size={14} />
 {:else}
 <Save size={14} />
 {/if}
 Save
 </button>
 </div>
 </div>

 <!-- Code editor + test panel -->
 <div class="flex flex-1 overflow-hidden">
 <!-- Code area -->
 <div class="flex-1 flex flex-col">
 <textarea
 class="flex-1 font-mono text-sm p-4 resize-none bg-base-900 text-base-content border-0 outline-none"
 style="background: #1e1e2e; color: #cdd6f4;"
 bind:value={selected.code}
 spellcheck="false"
 ></textarea>
 </div>

 <!-- Right: test panel -->
 <div class="w-72 border-l border-base-300 flex flex-col bg-base-100">
 <div class="p-3 border-b border-base-300">
 <p class="font-medium text-sm">Test Invoke</p>
 </div>
 <div class="p-3 flex-1 flex flex-col">
 <label class="label" for="invoke-body"><span class="label-text text-xs">Request body (JSON)</span></label>
 <textarea
 id="invoke-body"
bind:value={invokeInput}
 class="textarea textarea-sm font-mono flex-1 resize-none text-xs"
 placeholder="{}"
 ></textarea>
 <button
 class="btn btn-primary btn-sm mt-3 gap-1 w-full"
 onclick={invoke}
 disabled={invoking}
 >
 {#if invoking}
 <span class="loading loading-spinner loading-xs"></span>
 {:else}
 <Play size={12} />
 {/if}
 Run
 </button>

 {#if invokeResult}
 <div class="mt-3">
 <div class="flex items-center gap-2 mb-1">
 <span class="text-xs font-medium">Response</span>
 <span class="badge badge-xs {invokeResult.status < 400 ? 'badge-success' : 'badge-error'}">{invokeResult.status}</span>
 <span class="text-xs text-base-content/40">{invokeResult.duration_ms}ms</span>
 </div>
 <pre class="text-xs font-mono bg-base-200 rounded p-2 overflow-auto max-h-40">{invokeResult.body}</pre>
 {#if invokeResult.logs?.length}
 <div class="mt-2">
 <p class="text-xs font-medium mb-1">Console logs</p>
 {#each invokeResult.logs as log}
 <p class="text-xs font-mono text-base-content/60">{log}</p>
 {/each}
 </div>
 {/if}
 {#if invokeResult.error}
 <p class="text-xs text-error mt-1">{invokeResult.error}</p>
 {/if}
 </div>
 {/if}
 </div>
 </div>
 </div>
 </div>
 {:else if !loading}
 <div class="flex-1 flex items-center justify-center text-base-content/40">
 <div class="text-center">
 <Code size={64} class="mx-auto mb-4 opacity-20" />
 <p>Select a function or create one to get started</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>
 <Plus size={14} />
 New Function
 </button>
 </div>
 </div>
 {/if}
</div>

{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">New Edge Function</h3>
 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="fn-name"><span class="label-text">Name (URL-safe)</span></label>
 <input id="fn-name" type="text" bind:value={form.name} placeholder="my-function" class="input font-mono" />
 <p class="label"><span class="label-text-alt text-xs">Will be mounted at /api/fn/{form.name || '...'}</span></p>
 </div>
 <div class="form-control">
 <label class="label" for="fn-display-name"><span class="label-text">Display name</span></label>
 <input id="fn-display-name" type="text" bind:value={form.display_name} placeholder="My Function" class="input" />
 </div>
 <div class="form-control">
 <label class="label" for="fn-http-method"><span class="label-text">HTTP method</span></label>
 <select id="fn-http-method" bind:value={form.http_method} class="select">
 <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>ANY</option>
 </select>
 </div>
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createFunction} disabled={creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}
