<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { portalApi } from '$lib/api.js';
  import {
    Plus, Trash2, ExternalLink, Home, Layout, Palette, Hash,
    Layers, RefreshCw, GripVertical, Eye, EyeOff, LoaderCircle,
  } from '@lucide/svelte';

  interface PortalPage {
    id: string;
    title: string;
    slug: string;
    description?: string;
    is_active: boolean;
    is_homepage: boolean;
    layout: string;
    sort_order: number;
  }

  let pages = $state<PortalPage[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showModal = $state(false);
  let newPage = $state({ title: '', slug: '', description: '', layout: 'default' });
  let creating = $state(false);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await portalApi.listPages();
      pages = (res.pages ?? []).sort((a: PortalPage, b: PortalPage) => a.sort_order - b.sort_order);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function handleTitleInput(title: string) {
    newPage.title = title;
    if (!newPage.slug || newPage.slug === slugify(newPage.title)) {
      newPage.slug = slugify(title);
    }
  }

  async function createPage() {
    if (!newPage.title.trim() || !newPage.slug.trim()) return;
    creating = true;
    error = '';
    try {
      const res = await portalApi.createPage(newPage);
      showModal = false;
      newPage = { title: '', slug: '', description: '', layout: 'default' };
      goto(`${base}/portal/${res.page.id}`);
    } catch (e: any) {
      error = e.message;
    } finally {
      creating = false;
    }
  }

  async function deletePage(p: PortalPage) {
    if (!confirm(`Delete page "${p.title}"? All sections will be deleted too.`)) return;
    try {
      await portalApi.deletePage(p.id);
      pages = pages.filter(x => x.id !== p.id);
    } catch (e: any) {
      error = e.message;
    }
  }

  async function toggleActive(p: PortalPage) {
    try {
      const res = await portalApi.updatePage(p.id, { is_active: !p.is_active });
      pages = pages.map(x => x.id === p.id ? res.page : x);
    } catch (e: any) {
      error = e.message;
    }
  }

  async function setHomepage(p: PortalPage) {
    try {
      await portalApi.updatePage(p.id, { is_homepage: true });
      await load();
    } catch (e: any) {
      error = e.message;
    }
  }

  const LAYOUTS = [
    { value: 'default',        label: 'Default' },
    { value: 'full-width',     label: 'Full Width' },
    { value: 'sidebar-left',   label: 'Sidebar Left' },
    { value: 'sidebar-right',  label: 'Sidebar Right' },
    { value: 'landing',        label: 'Landing Page' },
  ];
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Portal Builder</h1>
      <p class="text-base-content/60 text-sm mt-1">Configure the pages and appearance of your end-user portal</p>
    </div>
    <div class="flex gap-2">
      <a href="{base}/portal/theme" class="btn btn-outline btn-sm gap-1">
        <Palette size={15}/> Theme
      </a>
      <button class="btn btn-ghost btn-sm" onclick={load} disabled={loading}>
        <RefreshCw size={15} class={loading ? 'animate-spin' : ''}/>
      </button>
      <button class="btn btn-primary btn-sm gap-1" onclick={() => showModal = true}>
        <Plus size={15}/> New Page
      </button>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={32} class="animate-spin text-primary"/>
    </div>
  {:else if pages.length === 0}
    <div class="text-center py-20 text-base-content/40">
      <Layout size={48} class="mx-auto mb-3 opacity-30"/>
      <p class="font-medium">No pages yet</p>
      <p class="text-sm mt-1">Create your first portal page to get started</p>
      <button class="btn btn-primary btn-sm mt-5 gap-1" onclick={() => showModal = true}>
        <Plus size={14}/> Create First Page
      </button>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each pages as p (p.id)}
        <div class="card bg-base-200 hover:bg-base-300 transition-colors {!p.is_active ? 'opacity-60' : ''}">
          <div class="card-body p-4 space-y-2">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <Layout size={15} class="opacity-50 shrink-0"/>
                <p class="font-semibold text-sm truncate">{p.title}</p>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                {#if p.is_homepage}
                  <span class="badge badge-primary badge-sm gap-0.5"><Home size={9}/> Home</span>
                {/if}
                {#if !p.is_active}
                  <span class="badge badge-ghost badge-sm">Draft</span>
                {/if}
              </div>
            </div>

            <div class="flex items-center gap-1 text-xs text-base-content/50">
              <Hash size={11}/>
              <code class="bg-base-300 px-1 rounded">{p.slug}</code>
              <span class="ml-auto opacity-60">{p.layout}</span>
            </div>

            {#if p.description}
              <p class="text-xs text-base-content/50 line-clamp-2">{p.description}</p>
            {/if}

            <!-- Actions -->
            <div class="flex items-center justify-between pt-2 border-t border-base-300">
              <div class="flex gap-1">
                <button
                  class="btn btn-ghost btn-xs"
                  onclick={() => toggleActive(p)}
                  title={p.is_active ? 'Set as draft' : 'Publish'}
                >
                  {#if p.is_active}
                    <Eye size={13} class="text-success"/>
                  {:else}
                    <EyeOff size={13} class="opacity-40"/>
                  {/if}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  onclick={() => setHomepage(p)}
                  title={p.is_homepage ? 'Is homepage' : 'Set as homepage'}
                >
                  <Home size={13} class={p.is_homepage ? 'text-primary' : 'opacity-30'}/>
                </button>
              </div>
              <div class="flex gap-1">
                <a href="{base}/portal/{p.id}" class="btn btn-ghost btn-xs gap-1 text-primary">
                  <Layers size={12}/> Edit
                </a>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deletePage(p)}>
                  <Trash2 size={12}/>
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
      <h3 class="font-bold text-lg mb-4">New Portal Page</h3>

      {#if error}<div class="alert alert-error text-sm mb-3">{error}</div>{/if}

      <div class="form-control mb-3">
        <label class="label" for="pt"><span class="label-text">Title *</span></label>
        <input id="pt" type="text" class="input" placeholder="e.g. Home, Products, About"
          bind:value={newPage.title}
          oninput={(e) => handleTitleInput(e.currentTarget.value)}/>
      </div>

      <div class="form-control mb-3">
        <label class="label" for="ps"><span class="label-text">Slug *</span></label>
        <div class="input-group">
          <span class="input-group-text text-base-content/40 text-sm">/</span>
          <input id="ps" type="text" class="input flex-1 font-mono" placeholder="about-us"
            bind:value={newPage.slug}/>
        </div>
        <p class="label"><span class="label-text-alt text-base-content/40">Use "/" for the homepage</span></p>
      </div>

      <div class="form-control mb-3">
        <label class="label" for="pdesc"><span class="label-text">Description</span></label>
        <textarea id="pdesc" class="textarea" rows={2} placeholder="Brief description…"
          bind:value={newPage.description}></textarea>
      </div>

      <div class="form-control mb-4">
        <label class="label" for="pl"><span class="label-text">Layout</span></label>
        <select id="pl" class="select" bind:value={newPage.layout}>
          {#each LAYOUTS as l}<option value={l.value}>{l.label}</option>{/each}
        </select>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => showModal = false}>Cancel</button>
        <button
          class="btn btn-primary gap-1"
          onclick={createPage}
          disabled={!newPage.title.trim() || !newPage.slug.trim() || creating}
        >
          {#if creating}<LoaderCircle size={15} class="animate-spin"/>{/if}
          Create & Edit
        </button>
      </div>
    </div>
    <div class="modal-backdrop" role="button" tabindex="0" aria-label="Close"
      onclick={() => showModal = false}
      onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }}></div>
  </div>
{/if}
