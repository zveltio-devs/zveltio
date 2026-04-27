<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { base } from '$app/paths';
  import {
    Plus, Layout, LayoutGrid, Globe, Lock, Users, LoaderCircle, Trash2,
    ToggleLeft, ToggleRight, ExternalLink,
  } from '@lucide/svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  let zones = $state<any[]>([]);
  let loading = $state(true);
  let showModal = $state(false);
  let creating = $state(false);
  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  let form = $state({
    name: '',
    slug: '',
    description: '',
    base_path: '',
    is_active: false,
    nav_position: 'sidebar',
  });

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
      const res = await api.get<{ zones: any[] }>('/api/zones');
      zones = res.zones ?? [];
    } catch {
      zones = [];
    } finally {
      loading = false;
    }
  }

  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function handleNameInput(name: string) {
    form.name = name;
    if (!form.slug || form.slug === slugify(form.name)) {
      form.slug = slugify(name);
    }
    if (!form.base_path || form.base_path === `/${slugify(form.name)}`) {
      form.base_path = `/${slugify(name)}`;
    }
  }

  async function createZone() {
    if (!form.name.trim() || !form.slug.trim() || !form.base_path.trim()) return;
    creating = true;
    try {
      await api.post('/api/zones', {
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description || undefined,
        base_path: form.base_path.trim(),
        is_active: form.is_active,
        nav_position: form.nav_position,
      });
      showModal = false;
      form = { name: '', slug: '', description: '', base_path: '', is_active: false, nav_position: 'sidebar' };
      await load();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      creating = false;
    }
  }

  async function deleteZone(slug: string, name: string) {
    confirmState = {
      open: true,
      title: 'Delete Zone',
      message: `Delete zone "${name}" and all its pages? This cannot be undone.`,
      confirmLabel: 'Delete Zone',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await api.delete(`/api/zones/${slug}`);
          zones = zones.filter(z => z.slug !== slug);
        } catch (e) {
          toast.error(extractError(e));
        }
      },
    };
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <PageHeader title="Zones" subtitle="Each zone is a complete portal with its own pages and access rules" count={zones.length}>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={15}/> New Zone
    </button>
  </PageHeader>

  {#if loading}
    <LoadingSkeleton type="card" rows={6} />
  {:else if zones.length === 0}
    <div class="flex flex-col items-center justify-center py-20 text-base-content/40 gap-3">
      <Layout size={48} class="opacity-20" />
      <p class="text-lg font-semibold text-base-content/60">No zones yet</p>
      <p class="text-sm text-center max-w-sm">Zones define your portal structure with pages and navigation.</p>
      <button class="btn btn-primary btn-sm mt-2" onclick={() => (showModal = true)}>New Zone</button>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each zones as z (z.id)}
        <div class="group card bg-base-200 hover:bg-base-300 transition-all border border-transparent hover:border-primary/30 hover:shadow-sm">
          <div class="card-body p-4 gap-3">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <div class="p-1.5 rounded-lg shrink-0" style="background-color: {z.primary_color ?? '#069494'}20">
                  <LayoutGrid size={14} style="color: {z.primary_color ?? '#069494'}"/>
                </div>
                <div class="min-w-0">
                  <h3 class="font-semibold text-sm truncate">{z.name}</h3>
                  <p class="text-xs text-base-content/40 font-mono truncate">{z.base_path}</p>
                </div>
              </div>
              <div class="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  class="btn btn-ghost btn-xs text-error"
                  onclick={() => deleteZone(z.slug, z.name)}
                  title="Delete"
                >
                  <Trash2 size={13}/>
                </button>
              </div>
            </div>

            <div class="flex gap-1.5 flex-wrap">
              {#if z.is_active}
                <span class="badge badge-success badge-xs gap-0.5"><Globe size={9}/> Active</span>
              {:else}
                <span class="badge badge-ghost badge-xs">Inactive</span>
              {/if}
              {#if z.access_roles?.length > 0}
                <span class="badge badge-warning badge-xs gap-0.5"><Lock size={9}/> Restricted</span>
              {:else}
                <span class="badge badge-ghost badge-xs gap-0.5"><Users size={9}/> Public</span>
              {/if}
            </div>

            {#if z.description}
              <p class="text-xs text-base-content/50 line-clamp-2">{z.description}</p>
            {/if}

            <div class="flex justify-end pt-1 border-t border-base-300">
              <a href="{base}/zones/{z.slug}" class="btn btn-ghost btn-xs gap-1 text-primary">
                Manage <ExternalLink size={11}/>
              </a>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Create Modal -->
{#if showModal}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New Zone</h3>

      <div class="form-control mb-3">
        <label class="label" for="zn"><span class="label-text">Name *</span></label>
        <input id="zn" type="text" class="input" placeholder="e.g. Client Portal"
          bind:value={form.name}
          oninput={(e) => handleNameInput(e.currentTarget.value)}/>
      </div>

      <div class="grid grid-cols-2 gap-3 mb-3">
        <div class="form-control">
          <label class="label" for="zs"><span class="label-text">Slug *</span></label>
          <input id="zs" type="text" class="input font-mono" placeholder="client"
            bind:value={form.slug}/>
        </div>
        <div class="form-control">
          <label class="label" for="zbp">
            <span class="label-text">Base path</span>
            <span class="label-text-alt text-base-content/40">Use <code class="font-mono">/</code> for root URLs</span>
          </label>
          <input id="zbp" type="text" class="input font-mono" placeholder="/client-portal"
            bind:value={form.base_path}/>
          <p class="text-xs text-base-content/40 mt-1 font-mono">
            {form.base_path === '/' ? 'ddd.com/pagina' : `ddd.com${form.base_path || ('/' + form.slug)}/pagina`}
          </p>
        </div>
      </div>

      <div class="form-control mb-3">
        <label class="label" for="znav"><span class="label-text">Navigation position</span></label>
        <select id="znav" class="select" bind:value={form.nav_position}>
          <option value="sidebar">Sidebar</option>
          <option value="topbar">Top bar</option>
          <option value="both">Both</option>
        </select>
      </div>

      <div class="form-control mb-4">
        <label class="label" for="zdesc"><span class="label-text">Description</span></label>
        <input id="zdesc" type="text" class="input" placeholder="Optional description…"
          bind:value={form.description}/>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => { showModal = false; }}>Cancel</button>
        <button
          class="btn btn-primary gap-1"
          onclick={createZone}
          disabled={!form.name.trim() || !form.slug.trim() || creating}
        >
          {#if creating}<LoaderCircle size={15} class="animate-spin"/>{/if}
          Create Zone
        </button>
      </div>
    </div>
    <div class="modal-backdrop" role="button" tabindex="0" aria-label="Close"
      onclick={() => { showModal = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') { showModal = false; } }}></div>
  </dialog>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
