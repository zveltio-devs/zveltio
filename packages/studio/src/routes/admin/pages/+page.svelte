<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import {
 Layout, Plus, FileText, Edit, Trash2, Home, RefreshCw,
 ExternalLink, Hash, Layers, LoaderCircle,
 } from '@lucide/svelte';

 interface Page {
 id: string;
 title: string;
 slug: string;
 description?: string;
 is_active: boolean;
 is_homepage: boolean;
 layout: string;
 section_count: number;
 created_at: string;
 updated_at: string;
 }

 let pages = $state<Page[]>([]);
 let loading = $state(true);
 let error = $state('');
 let showModal = $state(false);
 let newPage = $state({ title: '', slug: '', description: '', layout: 'default' });
 let creating = $state(false);

 onMount(loadPages);

 async function loadPages() {
 loading = true;
 error = '';
 try {
 const data = await api.get<{ pages: Page[] }>('/api/admin/pages');
 pages = data.pages || [];
 } catch (e: any) {
 error = e.message;
 } finally {
 loading = false;
 }
 }

 function generateSlug(title: string) {
 return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
 }

 function handleTitleInput(title: string) {
 newPage.title = title;
 if (!newPage.slug || newPage.slug === generateSlug(newPage.title)) {
 newPage.slug = generateSlug(title);
 }
 }

 async function createPage() {
 if (!newPage.title.trim() || !newPage.slug.trim()) return;
 creating = true;
 error = '';
 try {
 const result = await api.post<{ id: string }>('/api/admin/pages', newPage);
 showModal = false;
 newPage = { title: '', slug: '', description: '', layout: 'default' };
 await loadPages();
 } catch (e: any) {
 error = e.message;
 } finally {
 creating = false;
 }
 }

 async function deletePage(page: Page) {
 if (!confirm(`Delete page "${page.title}"? This will also delete all sections.`)) return;
 try {
 await api.delete(`/api/admin/pages/${page.id}`);
 pages = pages.filter(p => p.id !== page.id);
 } catch (e: any) {
 error = e.message;
 }
 }

 async function toggleActive(page: Page) {
 try {
 await api.put(`/api/admin/pages/${page.id}`, { is_active: !page.is_active });
 pages = pages.map(p => p.id === page.id ? { ...p, is_active: !p.is_active } : p);
 } catch (e: any) {
 error = e.message;
 }
 }

 async function setHomepage(page: Page) {
 try {
 await api.put(`/api/admin/pages/${page.id}`, { is_homepage: !page.is_homepage });
 // Reflect locally — server handles unsetting old homepage
 pages = pages.map(p => ({
 ...p,
 is_homepage: p.id === page.id ? !page.is_homepage : (page.is_homepage ? p.is_homepage : false),
 }));
 await loadPages(); // Reload to get accurate state from server
 } catch (e: any) {
 error = e.message;
 }
 }

 async function previewPage(page: Page) {
 try {
 const settings = await api.get<any>('/api/settings/public');
 const siteUrl = settings.site_url || settings.branding?.site_url;
 if (siteUrl) {
 window.open(page.is_homepage ? siteUrl : `${siteUrl}/${page.slug}`, '_blank');
 return;
 }
 } catch {}
 alert(`Configure Site URL in Settings to preview pages.\nOpen your client app and navigate to: /${page.slug}`);
 }

 function fmtDate(s: string) {
 return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
 }

 const layoutOptions = [
 { value: 'default', label: 'Default' },
 { value: 'full-width', label: 'Full Width' },
 { value: 'sidebar-left', label: 'Sidebar Left' },
 { value: 'sidebar-right', label: 'Sidebar Right' },
 ];
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Pages</h1>
 <p class="text-base-content/60 text-sm mt-1">Build pages with dynamic sections</p>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm" onclick={loadPages} disabled={loading}>
 <RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
 </button>
 <button class="btn btn-primary btn-sm" onclick={() => (showModal = true)}>
 <Plus size={16} /> New Page
 </button>
 </div>
 </div>

 {#if error}
 <div class="alert alert-error text-sm">{error}</div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-16">
 <LoaderCircle size={32} class="animate-spin text-primary" />
 </div>
 {:else if pages.length === 0}
 <div class="text-center py-16 text-base-content/40">
 <Layout size={48} class="mx-auto mb-3" />
 <p class="text-sm">No pages yet.</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showModal = true)}>
 <Plus size={14} /> Create First Page
 </button>
 </div>
 {:else}
 <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
 {#each pages as page}
 <div class="card bg-base-200 {!page.is_active ? 'opacity-60' : ''}">
 <div class="card-body p-4 space-y-2">
 <div class="flex items-start justify-between gap-2">
 <div class="flex items-center gap-2 min-w-0">
 <FileText size={16} class="opacity-50 shrink-0" />
 <p class="font-semibold text-sm truncate">{page.title}</p>
 </div>
 <div class="flex items-center gap-1 shrink-0">
 {#if page.is_homepage}
 <span class="badge badge-primary badge-sm"><Home size={10} /> Home</span>
 {/if}
 {#if !page.is_active}
 <span class="badge badge-ghost badge-sm">Inactive</span>
 {/if}
 </div>
 </div>

 <div class="flex items-center gap-1 text-xs opacity-60">
 <Hash size={12} />
 <code class="bg-base-300 px-1 rounded text-xs">{page.slug}</code>
 </div>

 {#if page.description}
 <p class="text-xs opacity-60 line-clamp-2">{page.description}</p>
 {/if}

 <div class="flex items-center gap-4 text-xs opacity-50">
 <span class="flex items-center gap-1"><Layers size={12} /> {page.section_count} sections</span>
 <span class="flex items-center gap-1"><Layout size={12} /> {page.layout}</span>
 </div>

 <div class="flex items-center justify-between pt-2 border-t border-base-300">
 <div class="flex gap-1">
 <button class="btn btn-ghost btn-xs" onclick={() => toggleActive(page)} title={page.is_active ? 'Deactivate' : 'Activate'}>
 <div class="w-2.5 h-2.5 rounded-full {page.is_active ? 'bg-success' : 'bg-base-300'}"></div>
 </button>
 <button class="btn btn-ghost btn-xs" onclick={() => setHomepage(page)} title={page.is_homepage ? 'Remove homepage' : 'Set as homepage'}>
 <Home size={13} class={page.is_homepage ? 'text-primary' : 'opacity-40'} />
 </button>
 </div>
 <div class="flex gap-1">
 <button class="btn btn-ghost btn-xs" onclick={() => previewPage(page)} title="Preview">
 <ExternalLink size={13} />
 </button>
 <button class="btn btn-ghost btn-xs text-error" onclick={() => deletePage(page)}>
 <Trash2 size={13} />
 </button>
 </div>
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>

<!-- Create Page Modal -->
{#if showModal}
 <div class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">Create New Page</h3>

 <div class="form-control mb-3">
 <label class="label" for="page-title"><span class="label-text">Title *</span></label>
 <input
 id="page-title"
 type="text"
 class="input"
 placeholder="e.g. Home, News, Products"
 bind:value={newPage.title}
 oninput={(e) => handleTitleInput(e.currentTarget.value)}
 />
 </div>

 <div class="form-control mb-3">
 <label class="label" for="page-slug"><span class="label-text">Slug *</span></label>
 <input
 id="page-slug"
 type="text"
 class="input font-mono"
 placeholder="e.g. home, news, products"
 bind:value={newPage.slug}
 />
 <p class="label"><span class="label-text-alt opacity-60">Lowercase, hyphens only</span></p>
 </div>

 <div class="form-control mb-3">
 <label class="label" for="page-desc"><span class="label-text">Description</span></label>
 <textarea id="page-desc" class="textarea" placeholder="Brief description for SEO" bind:value={newPage.description} rows={2}></textarea>
 </div>

 <div class="form-control mb-3">
 <label class="label" for="page-layout"><span class="label-text">Layout</span></label>
 <select id="page-layout" class="select" bind:value={newPage.layout}>
 {#each layoutOptions as opt}
 <option value={opt.value}>{opt.label}</option>
 {/each}
 </select>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showModal = false)}>Cancel</button>
 <button
 class="btn btn-primary"
 onclick={createPage}
 disabled={!newPage.title.trim() || !newPage.slug.trim() || creating}
 >
 {#if creating}<LoaderCircle size={16} class="animate-spin" />{/if}
 Create Page
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label="Close"
 onclick={() => (showModal = false)}
 onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }}
 ></div>
 </div>
{/if}
