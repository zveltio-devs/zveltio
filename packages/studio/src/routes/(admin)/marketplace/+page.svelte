<script lang="ts">
 import { onMount } from 'svelte';
 import {
 Package, CheckCircle, Power, PowerOff, Settings,
 Trash2, Download, RefreshCw, AlertTriangle, Puzzle,
 Workflow, Brain, FileText, Zap, Map, Shield, Code2, Star,
 Circle
 } from '@lucide/svelte';
 import { ENGINE_URL } from '$lib/config.js';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';
 import { toast } from '$lib/stores/toast.svelte.js';

 const CATEGORY_ICONS: Record<string, any> = {
 workflow: Workflow,
 ai: Brain,
 content: FileText,
 automation: Zap,
 geospatial: Map,
 compliance: Shield,
 developer: Code2,
 custom: Puzzle,
 };

 const CATEGORY_COLORS: Record<string, string> = {
 workflow: 'text-blue-500',
 ai: 'text-purple-500',
 content: 'text-orange-500',
 automation: 'text-yellow-500',
 geospatial: 'text-teal-500',
 compliance: 'text-red-500',
 developer: 'text-cyan-500',
 custom: 'text-gray-400',
 };

 interface Extension {
 name: string;
 displayName: string;
 description: string;
 category: string;
 version: string;
 author: string;
 tags: string[];
 bundled: boolean;
 is_installed: boolean;
 is_enabled: boolean;
 is_running: boolean;
 needs_restart: boolean;
 config: Record<string, any>;
 }

 let extensions = $state<Extension[]>([]);
 let loading = $state(true);
 let error = $state('');
 let processingId = $state<string | null>(null);
 let restartNeeded = $state(false);
 let searchQuery = $state('');
 let selectedCategory = $state('all');
 let configuringExt = $state<Extension | null>(null);
 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; confirmClass?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });
 let configJson = $state('{}');
 let configError = $state('');

 const allCategories = $derived(['all', ...new Set(extensions.map(e => e.category))]);

 let cat = $state('all');

 const CATEGORIES = ['data', 'ai', 'automation', 'communications', 'developer', 'compliance'];

 const filtered = $derived(
 extensions.filter(e => {
 const q = searchQuery.toLowerCase();
 const matchSearch = !q ||
 e.displayName.toLowerCase().includes(q) ||
 e.description.toLowerCase().includes(q) ||
 e.tags.some(t => t.includes(q));
 const matchCat = selectedCategory === 'all' || e.category === selectedCategory;
 const matchSideCat = cat === 'all' || e.category === cat;
 return matchSearch && matchCat && matchSideCat;
 })
 );

 const stats = $derived({
 total: extensions.length,
 installed: extensions.filter(e => e.is_installed).length,
 running: extensions.filter(e => e.is_running).length,
 });

 async function api(path: string, opts: RequestInit = {}) {
 const res = await fetch(`${ENGINE_URL}${path}`, {
 ...opts,
 credentials: 'include',
 headers: { 'Content-Type': 'application/json', ...opts.headers },
 });
 if (!res.ok) {
 const err = await res.json().catch(() => ({ error: 'Request failed' }));
 throw new Error(err.error || `HTTP ${res.status}`);
 }
 return res.json();
 }

 async function load() {
 loading = true;
 error = '';
 try {
 const data = await api('/api/marketplace');
 extensions = data.extensions || [];
 restartNeeded = extensions.some(e => e.needs_restart);
 } catch (e: any) {
 error = e.message;
 } finally {
 loading = false;
 }
 }

 async function install(ext: Extension) {
 processingId = ext.name;
 try {
 await api(`/api/marketplace/${encodeURIComponent(ext.name)}/install`, { method: 'POST' });
 await load();
 } catch (e: any) {
 toast.error(`Install failed: ${e.message}`);
 } finally {
 processingId = null;
 }
 }

 async function enable(ext: Extension) {
 processingId = ext.name;
 try {
 const res = await api(`/api/marketplace/${encodeURIComponent(ext.name)}/enable`, { method: 'POST' });
 if (res.needs_restart) restartNeeded = true;
 await load();
 } catch (e: any) {
 toast.error(`Enable failed: ${e.message}`);
 } finally {
 processingId = null;
 }
 }

 async function disable(ext: Extension) {
 confirmState = {
 open: true,
 title: 'Disable Extension',
 message: `Disable "${ext.displayName}"?${ext.is_running ? ' Takes effect after restart.' : ''}`,
 confirmLabel: 'Disable',
 confirmClass: 'btn-warning',
 onconfirm: async () => {
 confirmState.open = false;
 processingId = ext.name;
 try {
 const res = await api(`/api/marketplace/${encodeURIComponent(ext.name)}/disable`, { method: 'POST' });
 if (res.needs_restart) restartNeeded = true;
 await load();
 } catch (e: any) {
 toast.error(`Disable failed: ${e.message}`);
 } finally {
 processingId = null;
 }
 },
 };
 }

 async function uninstall(ext: Extension) {
 confirmState = {
 open: true,
 title: 'Uninstall Extension',
 message: `Uninstall "${ext.displayName}"? Configuration will be lost.`,
 confirmLabel: 'Uninstall',
 onconfirm: async () => {
 confirmState.open = false;
 processingId = ext.name;
 try {
 await api(`/api/marketplace/${encodeURIComponent(ext.name)}/uninstall`, { method: 'POST' });
 await load();
 } catch (e: any) {
 toast.error(`Uninstall failed: ${e.message}`);
 } finally {
 processingId = null;
 }
 },
 };
 }

 function openConfig(ext: Extension) {
 configuringExt = ext;
 configJson = JSON.stringify(ext.config || {}, null, 2);
 configError = '';
 }

 async function saveConfig() {
 if (!configuringExt) return;
 configError = '';
 try {
 const parsed = JSON.parse(configJson);
 await api(`/api/marketplace/${encodeURIComponent(configuringExt.name)}/config`, {
 method: 'PUT',
 body: JSON.stringify(parsed),
 });
 configuringExt = null;
 await load();
 } catch (e: any) {
 configError = e instanceof SyntaxError ? 'Invalid JSON' : e.message;
 }
 }

 onMount(load);
</script>

<div class="space-y-6">

 <PageHeader title="Marketplace" subtitle="Browse and install extensions">
  <button class="btn btn-ghost btn-sm gap-1" onclick={load} disabled={loading}>
  <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
  Refresh
  </button>
 </PageHeader>

 {#if restartNeeded}
 <div class="alert alert-warning py-2 mb-4 text-sm">
 <span>Some extensions require a server restart to take effect.</span>
 </div>
 {/if}

 {#if error}
 <div class="alert alert-error mb-6">{error}</div>
 {/if}

 <!-- Search bar -->
 <div class="mb-5">
 <input
 type="text"
 class="input input-sm w-full"
 placeholder="Search extensions..."
 bind:value={searchQuery}
 />
 </div>

 <!-- Sidebar + Grid -->
 <div class="flex gap-5">

  <!-- Sidebar categorii -->
  <nav class="w-36 shrink-0 space-y-0.5">
   <button class="w-full text-left px-3 py-1.5 rounded-lg text-sm
                  {cat === 'all' ? 'bg-primary/10 text-primary font-medium' : 'text-base-content/60 hover:bg-base-200'}"
           onclick={() => cat = 'all'}>
    All ({extensions.length})
   </button>
   {#each CATEGORIES as c}
    <button class="w-full text-left px-3 py-1.5 rounded-lg text-sm capitalize
                   {cat === c ? 'bg-primary/10 text-primary font-medium' : 'text-base-content/60 hover:bg-base-200'}"
            onclick={() => cat = c}>
     {c}
    </button>
   {/each}
  </nav>

  <!-- Grid -->
  <div class="flex-1">
 {#if loading}
 <div class="flex justify-center py-20">
 <span class="loading loading-spinner loading-lg text-primary"></span>
 </div>
 {:else if filtered.length === 0}
 <div class="text-center py-20 opacity-50">
 <Puzzle size={48} class="mx-auto mb-3" />
 <p>No extensions found</p>
 </div>
 {:else}
 <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
 {#each filtered as ext}
 {@const Icon = CATEGORY_ICONS[ext.category] ?? Puzzle}
 {@const iconColor = CATEGORY_COLORS[ext.category] ?? 'text-gray-400'}
 {@const isProcessing = processingId === ext.name}

 <div class="card bg-base-100 shadow-sm border transition-all
 {ext.is_running
 ? 'border-success/40'
 : ext.is_enabled && ext.needs_restart
 ? 'border-warning/40'
 : ext.is_installed
 ? 'border-primary/30'
 : 'border-base-300'}">
 <div class="card-body p-5">

 <!-- Card header -->
 <div class="flex items-start justify-between gap-2 mb-2">
 <div class="flex items-center gap-2 min-w-0">
 <Icon size={22} class={iconColor} />
 <div class="min-w-0">
 <h3 class="font-bold truncate">{ext.displayName}</h3>
 <p class="text-xs opacity-40">v{ext.version} · {ext.author}</p>
 </div>
 </div>

 <!-- Status badge -->
 {#if ext.is_running}
 <span class="badge badge-success badge-sm shrink-0 gap-1">
 <CheckCircle size={10} /> Running
 </span>
 {:else if ext.is_enabled && ext.needs_restart}
 <span class="badge badge-warning badge-sm shrink-0 gap-1">
 <AlertTriangle size={10} /> Restart
 </span>
 {:else if ext.is_installed}
 <span class="badge badge-ghost badge-sm shrink-0">Installed</span>
 {:else}
 <span class="badge badge-ghost badge-sm shrink-0 opacity-50">
 <Circle size={10} /> Available
 </span>
 {/if}
 </div>

 <!-- Description -->
 <p class="text-sm opacity-60 line-clamp-2 mb-3">{ext.description}</p>

 <!-- Tags -->
 <div class="flex flex-wrap gap-1 mb-4">
 {#each ext.tags.slice(0, 3) as tag}
 <span class="badge badge-xs badge-ghost">{tag}</span>
 {/each}
 {#if ext.bundled}
 <span class="badge badge-xs badge-primary gap-1">
 <Star size={8} /> Bundled
 </span>
 {/if}
 </div>

 <!-- Actions -->
 <div class="flex items-center gap-2 mt-auto">
 {#if isProcessing}
 <span class="loading loading-spinner loading-sm text-primary"></span>

 {:else if !ext.is_installed}
 <!-- Available, not installed -->
 <button class="btn btn-primary btn-sm flex-1 gap-1" onclick={() => install(ext)}>
 <Download size={14} /> Install
 </button>

 {:else if !ext.is_enabled && !ext.is_running}
 <!-- Installed but disabled -->
 <button class="btn btn-success btn-sm flex-1 gap-1" onclick={() => enable(ext)}>
 <Power size={14} /> Enable
 </button>
 <button class="btn btn-ghost btn-sm" onclick={() => openConfig(ext)} title="Configure">
 <Settings size={14} />
 </button>
 <button class="btn btn-ghost btn-sm text-error" onclick={() => uninstall(ext)} title="Uninstall">
 <Trash2 size={14} />
 </button>

 {:else}
 <!-- Running or pending restart -->
 <button class="btn btn-ghost btn-sm flex-1 gap-1 text-error" onclick={() => disable(ext)}>
 <PowerOff size={14} /> Disable
 </button>
 <button class="btn btn-ghost btn-sm" onclick={() => openConfig(ext)} title="Configure">
 <Settings size={14} />
 </button>
 {/if}
 </div>

 </div>
 </div>
 {/each}
 </div>
 {/if}
  </div><!-- /flex-1 -->
 </div><!-- /flex gap-5 -->

</div>

<!-- Config modal -->
{#if configuringExt}
 <div class="modal modal-open">
 <div class="modal-box max-w-lg">
 <h3 class="font-bold text-lg mb-1">Configure {configuringExt.displayName}</h3>
 <p class="text-sm opacity-60 mb-3">
 JSON configuration for this extension. Changes take effect on next restart.
 </p>

 <textarea
 class="textarea w-full font-mono text-sm h-48 {configError ? 'textarea-error' : ''}"
 bind:value={configJson}
 spellcheck={false}
 ></textarea>

 {#if configError}
 <p class="text-error text-sm mt-1">{configError}</p>
 {/if}

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => configuringExt = null}>Cancel</button>
 <button class="btn btn-primary" onclick={saveConfig}>Save Config</button>
 </div>
 </div>
 <button class="modal-backdrop" aria-label="Close" onclick={() => configuringExt = null}></button>
 </div>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
