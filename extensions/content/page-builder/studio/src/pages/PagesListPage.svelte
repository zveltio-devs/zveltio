<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, Edit, Trash2, Globe, FileText } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 let pages = $state<any[]>([]);
 let loading = $state(true);
 let filter = $state('all');
 let showCreateModal = $state(false);
 let creating = $state(false);

 let form = $state({ title: '', slug: '', description: '', template: 'default' });

 onMount(async () => {
 await loadPages();
 });

 async function loadPages() {
 loading = true;
 try {
 const qs = filter !== 'all' ? `?status=${filter}` : '';
 const res = await fetch(`${engineUrl}/api/pages${qs}`, { credentials: 'include' });
 const data = await res.json();
 pages = data.pages || [];
 } finally {
 loading = false;
 }
 }

 $effect(() => {
 if (filter) loadPages();
 });

 function slugify(title: string): string {
 return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
 }

 function onTitleInput() {
 if (!form.slug) form.slug = slugify(form.title);
 }

 async function createPage() {
 if (!form.title || !form.slug) return;
 creating = true;
 try {
 const res = await fetch(`${engineUrl}/api/pages`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(form),
 });
 if (!res.ok) throw new Error('Failed');
 const data = await res.json();
 showCreateModal = false;
 form = { title: '', slug: '', description: '', template: 'default' };
 // Navigate to editor
 window.location.hash = `#/pages/${data.page.id}/edit`;
 await loadPages();
 } finally {
 creating = false;
 }
 }

 async function deletePage(id: string, title: string) {
 if (!confirm(`Delete "${title}"?`)) return;
 await fetch(`${engineUrl}/api/pages/${id}`, { method: 'DELETE', credentials: 'include' });
 await loadPages();
 }

 function statusBadge(status: string) {
 if (status === 'published') return 'badge-success';
 if (status === 'archived') return 'badge-ghost';
 return 'badge-warning';
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Pages</h1>
 <p class="text-base-content/60 text-sm mt-1">Manage public pages with the visual builder</p>
 </div>
 <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
 <Plus size={16} />
 New Page
 </button>
 </div>

 <div class="tabs tabs-boxed w-fit">
 {#each ['all', 'draft', 'published', 'archived'] as s}
 <button class="tab {filter === s ? 'tab-active' : ''}" onclick={() => (filter = s)}>
 {s.charAt(0).toUpperCase() + s.slice(1)}
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if pages.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <FileText size={48} class="mx-auto text-base-content/20 mb-3" />
 <p class="text-base-content/60">No pages yet</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>Create First Page</button>
 </div>
 {:else}
 <div class="space-y-2">
 {#each pages as page}
 <div class="card bg-base-200">
 <div class="card-body p-4">
 <div class="flex items-center justify-between">
 <div>
 <div class="flex items-center gap-2">
 <h3 class="font-semibold">{page.title}</h3>
 <span class="badge badge-sm {statusBadge(page.status)}">{page.status}</span>
 </div>
 <p class="text-sm font-mono text-base-content/50">/{page.slug}</p>
 {#if page.description}
 <p class="text-sm text-base-content/40 mt-0.5">{page.description}</p>
 {/if}
 </div>
 <div class="flex gap-1">
 {#if page.status === 'published'}
 <a
 href="/{page.slug}"
 target="_blank"
 class="btn btn-ghost btn-xs gap-1"
 >
 <Globe size={12} />
 </a>
 {/if}
 <a
 href="#/pages/{page.id}/edit"
 class="btn btn-ghost btn-xs gap-1"
 >
 <Edit size={12} />
 Edit
 </a>
 <button
 class="btn btn-ghost btn-xs text-error"
 onclick={() => deletePage(page.id, page.title)}
 >
 <Trash2 size={12} />
 </button>
 </div>
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>

{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">New Page</h3>

 <div class="space-y-3">
 <div class="form-control">
 <label class="label" for="page-title"><span class="label-text">Title</span></label>
 <input
 type="text"
 bind:value={form.title}
 id="page-title"
oninput={onTitleInput}
 placeholder="About Us"
 class="input"
 />
 </div>
 <div class="form-control">
 <label class="label" for="page-slug"><span class="label-text">Slug</span></label>
 <div class="input flex items-center gap-1 pr-0">
 <span class="text-base-content/40 text-sm">/</span>
 <input id="page-slug" type="text" bind:value={form.slug} placeholder="about-us" class="flex-1 bg-transparent outline-none text-sm" />
 </div>
 </div>
 <div class="form-control">
 <label class="label" for="page-description"><span class="label-text">Description (optional)</span></label>
 <input id="page-description" type="text" bind:value={form.description} class="input input-sm" />
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createPage} disabled={creating || !form.title || !form.slug}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create & Edit
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}
