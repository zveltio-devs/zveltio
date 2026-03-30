<script lang="ts">
 import { onMount } from 'svelte';
 import { page } from '$app/state';
 import { collectionsApi, dataApi, api, viewsApi } from '$lib/api.js';
 import { ArrowLeft, Plus, Trash2, RefreshCw, Columns, GitFork, Sparkles, Save, Code, LayoutGrid } from '@lucide/svelte';
 import { base } from '$app/paths';
 import SnippetGenerator from '$lib/components/admin/SnippetGenerator.svelte';
 import ViewWrapper from '$lib/components/views/ViewWrapper.svelte';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
 import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';
 import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';

 const collectionName = $derived(page.params.name ?? '');
 let collection = $state<any>(null);
 let records = $state<any[]>([]);
 let pagination = $state<any>({ total: 0, page: 1, limit: 20 });
 let loading = $state(true);
 let activeTab = $state<'data' | 'schema' | 'ai' | 'code' | 'views'>('data');

 // Views tab state
 let savedViews = $state<any[]>([]);
 let activeViewId = $state<string | null>(null);
 let viewsLoading = $state(false);
 let savingView = $state(false);
 let newViewName = $state('');
 let showNewViewForm = $state(false);
 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

 const activeViewConfig = $derived(savedViews.find(v => v.id === activeViewId)?.config ?? {});

 // AI Search settings
 let aiSearchEnabled = $state(false);
 let aiSearchField = $state('');
 let savingAI = $state(false);
 let aiSaved = $state(false);

 onMount(async () => {
 await load();
 });

 async function load() {
 loading = true;
 try {
 const [colRes, dataRes] = await Promise.all([
 collectionsApi.get(collectionName),
 dataApi.list(collectionName, { limit: '20' }),
 ]);
 collection = colRes.collection;
 records = dataRes.records;
 pagination = dataRes.pagination;
 aiSearchEnabled = collection?.ai_search_enabled ?? false;
 aiSearchField = collection?.ai_search_field ?? '';
 } finally {
 loading = false;
 }
 }

 function getFields(): any[] {
 if (!collection) return [];
 const f = collection.fields;
 return typeof f === 'string' ? JSON.parse(f) : f || [];
 }

 async function deleteRecord(id: string) {
 confirmState = {
 open: true,
 title: 'Delete Record',
 message: 'Delete this record? This cannot be undone.',
 confirmLabel: 'Delete',
 onconfirm: async () => {
 confirmState.open = false;
 await dataApi.delete(collectionName, id);
 await load();
 },
 };
 }

 async function loadViews() {
 viewsLoading = true;
 try {
   const res = await viewsApi.list();
   // Filter views that belong to this collection
   savedViews = (res.views ?? []).filter((v: any) => v.collection === collectionName);
   if (savedViews.length && !activeViewId) activeViewId = savedViews[0].id;
 } catch { savedViews = []; }
 finally { viewsLoading = false; }
 }

 async function createView() {
 if (!newViewName.trim()) return;
 savingView = true;
 try {
   const res = await viewsApi.create({
     name: newViewName.trim(),
     collection: collectionName,
     view_type: 'table',
     config: { pageSize: 25 },
   });
   savedViews = [...savedViews, res.view];
   activeViewId = res.view.id;
   newViewName = '';
   showNewViewForm = false;
 } finally { savingView = false; }
 }

 async function saveViewConfig(config: Record<string, any>) {
 if (!activeViewId) return;
 try {
   const res = await viewsApi.update(activeViewId, { config });
   savedViews = savedViews.map(v => v.id === activeViewId ? res.view : v);
 } catch { /* silent */ }
 }

 async function deleteView(id: string) {
 confirmState = {
 open: true,
 title: 'Delete View',
 message: 'Delete this view? This cannot be undone.',
 confirmLabel: 'Delete',
 onconfirm: async () => {
 confirmState.open = false;
 await viewsApi.delete(id);
 savedViews = savedViews.filter(v => v.id !== id);
 if (activeViewId === id) activeViewId = savedViews[0]?.id ?? null;
 },
 };
 }

 async function saveAISettings() {
 savingAI = true;
 aiSaved = false;
 try {
 await api.patch(`/api/collections/${collectionName}`, {
 aiSearchEnabled,
 aiSearchField: aiSearchField || null,
 });
 aiSaved = true;
 setTimeout(() => { aiSaved = false; }, 3000);
 } finally {
 savingAI = false;
 }
 }
</script>

<div class="space-y-6">
 <!-- Breadcrumb -->
 <Breadcrumb crumbs={[
   { label: 'Collections', href: `${base}/collections` },
   { label: collection?.display_name || collectionName },
 ]} />
 <!-- Header -->
 <div class="flex items-center gap-3">
 <div>
 <h1 class="text-2xl font-bold">{collection?.display_name || collectionName}</h1>
 <p class="text-base-content/60 text-sm">{collectionName}</p>
 </div>
 </div>

 <!-- Tabs -->
 <div class="tabs tabs-bordered">
 <button
 class="tab {activeTab === 'data' ? 'tab-active' : ''}"
 onclick={() => (activeTab = 'data')}
 >
 Data
 </button>
 <button
 class="tab {activeTab === 'schema' ? 'tab-active' : ''}"
 onclick={() => (activeTab = 'schema')}
 >
 Schema
 </button>
 <a href="{base}/collections/{collectionName}/fields" class="tab gap-1">
 <Columns size={14} />
 Fields
 </a>
 <a href="{base}/collections/{collectionName}/relations" class="tab gap-1">
 <GitFork size={14} />
 Relations
 </a>
 <button
 class="tab gap-1 {activeTab === 'ai' ? 'tab-active' : ''}"
 onclick={() => (activeTab = 'ai')}
 >
 <Sparkles size={14} />
 AI Search
 </button>
 <button
 class="tab gap-1 {activeTab === 'code' ? 'tab-active' : ''}"
 onclick={() => (activeTab = 'code')}
 >
 <Code size={14} />
 Code
 </button>
 <button
 class="tab gap-1 {activeTab === 'views' ? 'tab-active' : ''}"
 onclick={() => { activeTab = 'views'; loadViews(); }}
 >
 <LayoutGrid size={14} />
 Views
 </button>
 </div>

 {#if activeTab === 'data'}
 <div class="flex justify-between items-center">
 <span class="text-sm text-base-content/60">{pagination.total} records</span>
 <button onclick={load} class="btn btn-ghost btn-sm">
 <RefreshCw size={14} />
 </button>
 </div>

 {#if loading}
 <div class="flex justify-center py-12">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
 {:else}
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 {#each getFields().filter((f) => f.type !== 'computed') as field}
 <th>{field.label || field.name}</th>
 {/each}
 <th>Created</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each records as record}
 <tr>
 {#each getFields().filter((f) => f.type !== 'computed') as field}
 <td class="max-w-xs truncate">
 {#if record[field.name] === null || record[field.name] === undefined}
 <span class="text-base-content/30">—</span>
 {:else if typeof record[field.name] === 'object'}
 <code class="text-xs">{JSON.stringify(record[field.name])}</code>
 {:else}
 {record[field.name]}
 {/if}
 </td>
 {/each}
 <td class="text-xs text-base-content/50">
 {new Date(record.created_at).toLocaleDateString()}
 </td>
 <td>
 <button
 onclick={() => deleteRecord(record.id)}
 class="btn btn-ghost btn-xs text-error"
 >
 <Trash2 size={12} />
 </button>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 {/if}
{:else if activeTab === 'schema'}
 <!-- Schema tab -->
 {#if loading}
   <LoadingSkeleton type="table" rows={6} cols={4} />
 {:else}
 <div class="space-y-2">
 {#if getFields().length === 0}
   <div class="text-sm text-base-content/40 py-4">No custom fields defined. <a href="{base}/collections/{collectionName}/fields" class="link">Add fields →</a></div>
 {:else}
 {#each getFields() as field}
 <div class="flex items-center justify-between px-4 py-3 rounded-lg bg-base-200 hover:bg-base-300 transition-colors">
   <div class="flex items-center gap-3">
     <code class="font-mono font-semibold text-sm">{field.name}</code>
     {#if field.label && field.label !== field.name}
       <span class="text-base-content/40 text-xs">{field.label}</span>
     {/if}
   </div>
   <div class="flex gap-1.5 items-center">
     <span class="badge badge-outline badge-sm font-mono">{field.type}</span>
     {#if field.required}<span class="badge badge-warning badge-xs">required</span>{/if}
     {#if field.unique}<span class="badge badge-info badge-xs">unique</span>{/if}
   </div>
 </div>
 {/each}
 {/if}

 <div class="divider text-xs opacity-50 my-4">System fields (auto-managed)</div>
 {#each [
   { name: 'id', type: 'uuid' },
   { name: 'created_at', type: 'timestamp' },
   { name: 'updated_at', type: 'timestamp' },
   { name: 'status', type: 'text' },
   { name: 'created_by', type: 'uuid' },
   { name: 'updated_by', type: 'uuid' },
 ] as sf}
 <div class="flex items-center justify-between px-4 py-2 rounded-lg opacity-40">
   <code class="font-mono text-sm">{sf.name}</code>
   <span class="badge badge-ghost badge-xs font-mono">{sf.type}</span>
 </div>
 {/each}
 </div>
 {/if}
 {:else if activeTab === 'ai'}
 <!-- AI Search settings -->
 <div class="card bg-base-200 max-w-xl">
 <div class="card-body">
 <div class="flex items-center gap-2 mb-4">
 <Sparkles size={20} class="text-primary" />
 <h2 class="card-title text-base">AI Semantic Search</h2>
 </div>
 <p class="text-sm text-base-content/60 mb-4">
 Enable auto-embedding on create/update. Records will be indexed semantically
 and can be queried via <code class="text-primary">POST /api/ai/search</code>.
 Requires an AI provider with embedding support configured.
 </p>

 <div class="form-control mb-4">
 <label class="label cursor-pointer justify-start gap-3">
 <input
 type="checkbox"
 class="toggle toggle-primary"
 bind:checked={aiSearchEnabled}
 />
 <span class="label-text font-medium">Enable AI Search for this collection</span>
 </label>
 </div>

 {#if aiSearchEnabled}
 <div class="form-control mb-4">
 <label class="label">
 <span class="label-text">Field to embed</span>
 <span class="label-text-alt text-base-content/50">optional — blank = concat all text fields</span>
 </label>
 <select class="select" bind:value={aiSearchField}>
 <option value="">— Auto (all text fields) —</option>
 {#each getFields().filter((f) => ['text', 'textarea', 'richtext'].includes(f.type)) as field}
 <option value={field.name}>{field.label || field.name} ({field.type})</option>
 {/each}
 </select>
 </div>
 {/if}

 <div class="card-actions">
 <button
 class="btn btn-primary btn-sm"
 onclick={saveAISettings}
 disabled={savingAI}
 >
 {#if savingAI}
 <span class="loading loading-spinner loading-xs"></span>
 {:else}
 <Save size={14} />
 {/if}
 {aiSaved ? 'Saved!' : 'Save AI settings'}
 </button>
 </div>
 </div>
 </div>

 <div class="alert alert-info max-w-xl">
 <Sparkles size={16} />
 <div class="text-sm">
 <strong>How it works:</strong> On every create/update, Zveltio automatically generates
 an embedding for the selected field (or all text fields) and stores it in
 <code>zvd_ai_embeddings</code>. Semantic search returns records ordered
 by cosine similarity.
 </div>
 </div>
 {:else if activeTab === 'code'}
 <SnippetGenerator collectionName={collectionName} fields={getFields()} />
{:else if activeTab === 'views'}
 <!-- Views tab -->
 <div class="flex gap-4 h-150 min-h-0">
   <!-- Sidebar: saved views list -->
   <div class="w-52 shrink-0 flex flex-col gap-2">
     <div class="flex items-center justify-between">
       <span class="text-xs font-medium text-base-content/50 uppercase tracking-wide">Saved Views</span>
       <button class="btn btn-ghost btn-xs" onclick={() => showNewViewForm = !showNewViewForm} title="New view">
         <Plus size={12}/>
       </button>
     </div>

     {#if showNewViewForm}
       <div class="flex gap-1">
         <input
           class="input input-xs input-bordered flex-1 min-w-0"
           type="text"
           placeholder="View name…"
           bind:value={newViewName}
           onkeydown={(e) => e.key === 'Enter' && createView()}
           autofocus
         />
         <button class="btn btn-primary btn-xs" onclick={createView} disabled={savingView}>
           {#if savingView}<span class="loading loading-spinner loading-xs"/>{:else}<Save size={12}/>{/if}
         </button>
       </div>
     {/if}

     {#if viewsLoading}
       <div class="flex flex-col gap-1.5">
         {#each Array(3) as _}<div class="skeleton h-8 rounded-lg"/>{/each}
       </div>
     {:else if savedViews.length === 0}
       <p class="text-xs text-base-content/40 py-2">No views yet. Click + to create one.</p>
     {:else}
       {#each savedViews as v}
         <div class="flex items-center gap-1">
           <button
             class="flex-1 text-left px-2 py-1.5 rounded-lg text-sm truncate transition-colors"
             class:bg-primary={activeViewId === v.id}
             class:text-primary-content={activeViewId === v.id}
             class:bg-base-200={activeViewId !== v.id}
             class:hover:bg-base-300={activeViewId !== v.id}
             onclick={() => activeViewId = v.id}
           >
             {v.name}
           </button>
           <button
             class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100 hover:opacity-100"
             onclick={() => deleteView(v.id)}
             title="Delete view"
           >
             <Trash2 size={11}/>
           </button>
         </div>
       {/each}
     {/if}
   </div>

   <!-- Main: ViewWrapper -->
   <div class="flex-1 min-w-0 border border-base-300 rounded-xl overflow-hidden">
     {#if activeViewId}
       <ViewWrapper
         collection={collectionName}
         fields={getFields()}
         data={records}
         total={pagination.total}
         {loading}
         config={activeViewConfig}
         onConfigChange={saveViewConfig}
         onFetch={async ({ page: p, pageSize, sort, sortDir, filters, search }) => {
           loading = true;
           const params: Record<string,string> = { limit: String(pageSize), page: String(p) };
           if (sort) params.sort = sortDir === 'desc' ? `-${sort}` : sort;
           if (search) params.search = search;
           try {
             const res = await dataApi.list(collectionName, params);
             records = res.records;
             pagination = res.pagination;
           } finally { loading = false; }
         }}
         onCreate={() => { /* TODO: open create modal */ }}
         onDelete={async (row) => { await deleteRecord(row.id); }}
       />
     {:else}
       <div class="flex items-center justify-center h-full text-base-content/40 text-sm">
         Select or create a view to get started
       </div>
     {/if}
   </div>
 </div>
{/if}
</div>

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
