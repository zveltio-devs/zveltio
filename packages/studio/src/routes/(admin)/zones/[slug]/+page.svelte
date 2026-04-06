<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { api } from '$lib/api.js';
  import { base } from '$app/paths';
  import {
    ArrowLeft, Plus, Trash2, Save, Settings, Users, Palette,
    Home, Eye, EyeOff, ToggleLeft, ToggleRight, Layout, LoaderCircle,
    GripVertical, ChevronRight,
  } from '@lucide/svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  const zoneSlug = $derived((page.params as Record<string, string>).slug ?? '');

  let zone = $state<any>(null);
  let pages = $state<any[]>([]);
  let views = $state<any[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let tab = $state<'pages' | 'access' | 'branding'>('pages');
  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  let showAddPage = $state(false);
  let newPage = $state({ title: '', slug: '', description: '', auth_required: true });
  let creatingPage = $state(false);

  function extractError(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      if (typeof o.message === 'string') return o.message;
      if (typeof o.error === 'string') return o.error;
    }
    return 'An unexpected error occurred.';
  }

  onMount(load);

  async function load() {
    loading = true;
    try {
      const [zoneRes, pagesRes, viewsRes] = await Promise.all([
        api.get<{ zone: any }>(`/api/zones/${zoneSlug}`),
        api.get<{ pages: any[] }>(`/api/zones/${zoneSlug}/pages`),
        api.get<{ views: any[]; total: number }>('/api/views?limit=200'),
      ]);
      zone = zoneRes.zone;
      pages = pagesRes.pages ?? [];
      views = viewsRes.views ?? [];
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      loading = false;
    }
  }

  async function saveZone() {
    saving = true;
    try {
      const res = await api.put(`/api/zones/${zoneSlug}`, {
        name: zone.name,
        description: zone.description,
        is_active: zone.is_active,
        access_roles: zone.access_roles,
        site_name: zone.site_name,
        site_logo_url: zone.site_logo_url,
        primary_color: zone.primary_color,
        custom_css: zone.custom_css,
        nav_position: zone.nav_position,
        show_breadcrumbs: zone.show_breadcrumbs,
      });
      zone = (res as any).zone;
      toast.success('Zone saved.');
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function slugifyPage(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  async function addPage() {
    if (!newPage.title.trim() || !newPage.slug.trim()) return;
    creatingPage = true;
    try {
      const res = await api.post<{ page: any }>(`/api/zones/${zoneSlug}/pages`, {
        title: newPage.title.trim(),
        slug: newPage.slug.trim(),
        description: newPage.description || undefined,
        auth_required: newPage.auth_required,
      });
      pages = [...pages, (res as any).page];
      newPage = { title: '', slug: '', description: '', auth_required: true };
      showAddPage = false;
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      creatingPage = false;
    }
  }

  async function deletePage(slug: string, title: string) {
    confirmState = {
      open: true,
      title: 'Delete Page',
      message: `Delete page "${title}"?`,
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await api.delete(`/api/zones/${zoneSlug}/pages/${slug}`);
          pages = pages.filter(p => p.slug !== slug);
        } catch (e) {
          toast.error(extractError(e));
        }
      },
    };
  }

  async function togglePageActive(p: any) {
    try {
      const res = await api.put<{ page: any }>(`/api/zones/${zoneSlug}/pages/${p.slug}`, {
        is_active: !p.is_active,
      });
      pages = pages.map(x => x.id === p.id ? (res as any).page : x);
    } catch (e) {
      toast.error(extractError(e));
    }
  }

  async function setHomepage(p: any) {
    try {
      await api.put(`/api/zones/${zoneSlug}/pages/${p.slug}`, { is_homepage: true });
      await load();
    } catch (e) {
      toast.error(extractError(e));
    }
  }

  function rolesInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    zone.access_roles = val.split(',').map((r: string) => r.trim()).filter(Boolean);
  }
</script>

<div class="space-y-6">
  <!-- Breadcrumb -->
  <Breadcrumb crumbs={[
    { label: 'Zones', href: `${base}/zones` },
    { label: zone?.name || zoneSlug },
  ]} />
  <PageHeader title={zone?.name ?? zoneSlug} subtitle={zone?.base_path}>
    {#if zone}
      <button class="btn btn-ghost btn-sm" onclick={() => (zone.is_active = !zone.is_active)}>
        {#if zone.is_active}
          <ToggleRight size={24} class="text-success"/>
        {:else}
          <ToggleLeft size={24} class="text-base-content/30"/>
        {/if}
      </button>
    {/if}
  </PageHeader>

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={28} class="animate-spin text-primary"/>
    </div>
  {:else if zone}
    <!-- Tabs -->
    <div class="tabs tabs-bordered">
      <button class="tab gap-1.5 {tab === 'pages' ? 'tab-active' : ''}" onclick={() => (tab = 'pages')}>
        <Layout size={14}/> Pages
      </button>
      <button class="tab gap-1.5 {tab === 'access' ? 'tab-active' : ''}" onclick={() => (tab = 'access')}>
        <Users size={14}/> Access
      </button>
      <button class="tab gap-1.5 {tab === 'branding' ? 'tab-active' : ''}" onclick={() => (tab = 'branding')}>
        <Palette size={14}/> Branding
      </button>
    </div>

    <!-- Pages Tab -->
    {#if tab === 'pages'}
      <div class="flex items-center justify-between">
        <p class="text-sm text-base-content/60">{pages.length} page{pages.length !== 1 ? 's' : ''}</p>
        <button class="btn btn-primary btn-sm gap-1" onclick={() => (showAddPage = !showAddPage)}>
          <Plus size={14}/> Add Page
        </button>
      </div>

      {#if showAddPage}
        <div class="card bg-base-200 border border-primary/30">
          <div class="card-body p-4 gap-3">
            <h4 class="font-semibold text-sm">New Page</h4>
            <div class="grid grid-cols-2 gap-3">
              <div class="form-control">
                <label class="label py-0" for="new-page-title"><span class="label-text text-xs">Title *</span></label>
                <input id="new-page-title" type="text" class="input input-sm" placeholder="e.g. Dashboard"
                  bind:value={newPage.title}
                  oninput={(e) => {
                    newPage.title = e.currentTarget.value;
                    if (!newPage.slug || newPage.slug === slugifyPage(newPage.title))
                      newPage.slug = slugifyPage(e.currentTarget.value);
                  }}/>
              </div>
              <div class="form-control">
                <label class="label py-0" for="new-page-slug"><span class="label-text text-xs">Slug *</span></label>
                <input id="new-page-slug" type="text" class="input input-sm font-mono" placeholder="dashboard"
                  bind:value={newPage.slug}/>
              </div>
            </div>
            <div class="form-control">
              <label class="label py-0 cursor-pointer justify-start gap-2">
                <input type="checkbox" class="checkbox checkbox-xs" bind:checked={newPage.auth_required}/>
                <span class="label-text text-xs">Require authentication</span>
              </label>
            </div>
            <div class="flex gap-2">
              <button class="btn btn-primary btn-sm gap-1" onclick={addPage}
                disabled={!newPage.title.trim() || !newPage.slug.trim() || creatingPage}>
                {#if creatingPage}<LoaderCircle size={13} class="animate-spin"/>{:else}<Save size={13}/>{/if}
                Save
              </button>
              <button class="btn btn-ghost btn-sm" onclick={() => (showAddPage = false)}>Cancel</button>
            </div>
          </div>
        </div>
      {/if}

      {#if pages.length === 0}
        <div class="card bg-base-200">
          <div class="card-body items-center text-center py-12 gap-2">
            <Layout size={32} class="text-base-content/20"/>
            <p class="text-base-content/50 font-medium text-sm">No pages yet</p>
            <p class="text-xs text-base-content/40">Add a page to start building this zone.</p>
          </div>
        </div>
      {:else}
        <div class="space-y-2">
          {#each pages as p (p.id)}
            <div class="card bg-base-200 hover:bg-base-300 transition-colors">
              <div class="card-body p-3 flex-row items-center gap-3">
                <GripVertical size={14} class="text-base-content/20 shrink-0 cursor-grab"/>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <p class="font-medium text-sm truncate">{p.title}</p>
                    {#if p.is_homepage}
                      <span class="badge badge-primary badge-xs gap-0.5"><Home size={9}/> Home</span>
                    {/if}
                    {#if !p.is_active}
                      <span class="badge badge-ghost badge-xs">Draft</span>
                    {/if}
                  </div>
                  <p class="text-xs text-base-content/40 font-mono">{p.slug}</p>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button class="btn btn-ghost btn-xs" onclick={() => togglePageActive(p)}
                    title={p.is_active ? 'Set as draft' : 'Publish'}>
                    {#if p.is_active}
                      <Eye size={13} class="text-success"/>
                    {:else}
                      <EyeOff size={13} class="opacity-40"/>
                    {/if}
                  </button>
                  <button class="btn btn-ghost btn-xs" onclick={() => setHomepage(p)}
                    title="Set as homepage">
                    <Home size={13} class={p.is_homepage ? 'text-primary' : 'opacity-30'}/>
                  </button>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deletePage(p.slug, p.title)}>
                    <Trash2 size={13}/>
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

    <!-- Access Tab -->
    {:else if tab === 'access'}
      <div class="card bg-base-200 border border-base-300 max-w-lg">
        <div class="card-body gap-4">
          <div class="card bg-base-100 border border-base-300">
            <div class="card-body p-4 flex-row items-center justify-between">
              <div>
                <p class="font-semibold text-sm">Zone active</p>
                <p class="text-xs text-base-content/50">Enable to make this zone accessible</p>
              </div>
              <button onclick={() => (zone.is_active = !zone.is_active)}>
                {#if zone.is_active}
                  <ToggleRight size={30} class="text-primary"/>
                {:else}
                  <ToggleLeft size={30} class="text-base-content/30"/>
                {/if}
              </button>
            </div>
          </div>

          <div class="form-control">
            <label class="label" for="zone-access-roles"><span class="label-text text-sm font-medium">Access roles</span>
              <span class="label-text-alt text-xs text-base-content/40">empty = all roles</span>
            </label>
            <input id="zone-access-roles" type="text" class="input input-sm"
              placeholder="employee, manager, client (comma-separated)"
              value={zone.access_roles?.join(', ') ?? ''}
              oninput={rolesInput}/>
            <p class="label"><span class="label-text-alt">Leave empty to allow any authenticated user</span></p>
          </div>

          <div class="flex justify-end">
            <button class="btn btn-primary btn-sm gap-1" onclick={saveZone} disabled={saving}>
              {#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<Save size={14}/>{/if}
              Save Access
            </button>
          </div>
        </div>
      </div>

    <!-- Branding Tab -->
    {:else if tab === 'branding'}
      <div class="card bg-base-200 border border-base-300 max-w-lg">
        <div class="card-body gap-4">
          <div class="grid sm:grid-cols-2 gap-4">
            <div class="form-control gap-1">
              <label class="label py-0" for="zone-site-name"><span class="label-text text-xs font-medium">Portal name</span></label>
              <input id="zone-site-name" type="text" class="input input-sm" placeholder="Client Portal"
                bind:value={zone.site_name}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0" for="zone-primary-color"><span class="label-text text-xs font-medium">Primary color</span></label>
              <div class="flex gap-2">
                <input type="color" bind:value={zone.primary_color}
                  class="w-10 h-8 rounded border border-base-300 cursor-pointer p-0.5"/>
                <input id="zone-primary-color" type="text" bind:value={zone.primary_color}
                  class="input input-sm flex-1 font-mono text-xs" placeholder="#069494"/>
              </div>
            </div>
            <div class="form-control gap-1 sm:col-span-2">
              <label class="label py-0" for="zone-logo-url"><span class="label-text text-xs font-medium">Logo URL <span class="text-base-content/40">(optional)</span></span></label>
              <input id="zone-logo-url" type="url" class="input input-sm" placeholder="https://…"
                bind:value={zone.site_logo_url}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0" for="zone-nav-position"><span class="label-text text-xs font-medium">Navigation</span></label>
              <select id="zone-nav-position" class="select select-sm" bind:value={zone.nav_position}>
                <option value="sidebar">Sidebar</option>
                <option value="topbar">Top bar</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0 cursor-pointer justify-start gap-2">
                <input type="checkbox" class="checkbox checkbox-sm" bind:checked={zone.show_breadcrumbs}/>
                <span class="label-text text-xs font-medium">Show breadcrumbs</span>
              </label>
            </div>
          </div>

          <!-- Live preview -->
          <div class="mt-1">
            <p class="text-xs text-base-content/40 mb-2">Portal header preview:</p>
            <div class="flex items-center gap-3 bg-base-100 rounded-xl px-4 py-3 border border-base-300">
              <div class="w-8 h-8 rounded-lg flex items-center justify-center"
                style="background-color: {zone.primary_color ?? '#069494'}">
                <span class="text-white font-bold text-sm leading-none">
                  {(zone.site_name ?? zone.name)?.[0]?.toUpperCase() ?? 'Z'}
                </span>
              </div>
              <div>
                <p class="font-semibold text-sm leading-none">{zone.site_name || zone.name}</p>
                <p class="text-[11px] text-base-content/40 mt-0.5">{zone.base_path}</p>
              </div>
            </div>
          </div>

          <div class="form-control gap-1">
            <label class="label py-0" for="zone-custom-css"><span class="label-text text-xs font-medium">Custom CSS <span class="text-base-content/40">(optional)</span></span></label>
            <textarea id="zone-custom-css" class="textarea textarea-sm font-mono text-xs h-24"
              placeholder="/* e.g. --primary: #3b82f6; */"
              bind:value={zone.custom_css}></textarea>
          </div>

          <div class="flex justify-end">
            <button class="btn btn-primary btn-sm gap-1" onclick={saveZone} disabled={saving}>
              {#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<Save size={14}/>{/if}
              Save Branding
            </button>
          </div>
        </div>
      </div>
    {/if}
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
