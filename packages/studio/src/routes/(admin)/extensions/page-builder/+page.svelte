<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import {
    Plus, Trash2, Save, LoaderCircle, Eye, EyeOff, FileText,
  } from '@lucide/svelte';

  type Block = { type: string; content: Record<string, unknown> };
  type Page = {
    id: string; title: string; slug: string; blocks: Block[];
    meta_title: string | null; meta_description: string | null;
    status: 'draft' | 'published'; created_at: string; updated_at: string;
    published_at: string | null;
  };

  let pages = $state<Page[]>([]);
  let loading = $state(true);
  let selected = $state<Page | null>(null);
  let view = $state<'list' | 'edit'>('list');
  let saving = $state(false);
  let showNew = $state(false);
  let form = $state({ title: '', slug: '' });

  const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'html'];

  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function extractError(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object') return (e as any).message ?? (e as any).error ?? 'Unknown error';
    return String(e);
  }

  onMount(load);

  async function load() {
    loading = true;
    try {
      const res = await api.get<{ pages: Page[] }>('/api/ext/pages');
      pages = res.pages ?? [];
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      loading = false;
    }
  }

  async function createPage() {
    if (!form.title.trim() || !form.slug.trim()) return;
    saving = true;
    try {
      const res = await api.post<{ page: Page }>('/api/ext/pages', {
        title: form.title.trim(),
        slug: form.slug.trim(),
        blocks: [],
        status: 'draft',
      });
      pages = [res.page, ...pages];
      form = { title: '', slug: '' };
      showNew = false;
      openEdit(res.page);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function openEdit(p: Page) {
    selected = JSON.parse(JSON.stringify(p)); // deep clone
    view = 'edit';
  }

  async function savePage() {
    if (!selected) return;
    saving = true;
    try {
      const res = await api.put<{ page: Page }>(`/api/ext/pages/${selected.id}`, {
        title: selected.title,
        slug: selected.slug,
        blocks: selected.blocks,
        meta_title: selected.meta_title || null,
        meta_description: selected.meta_description || null,
        status: selected.status,
      });
      selected = res.page;
      pages = pages.map(p => p.id === res.page.id ? res.page : p);
      toast.success('Page saved.');
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  async function deletePage(id: string) {
    if (!confirm('Delete this page?')) return;
    try {
      await api.delete(`/api/ext/pages/${id}`);
      pages = pages.filter(p => p.id !== id);
      if (selected?.id === id) { selected = null; view = 'list'; }
    } catch (e) {
      toast.error(extractError(e));
    }
  }

  async function toggleStatus() {
    if (!selected) return;
    selected.status = selected.status === 'published' ? 'draft' : 'published';
    await savePage();
  }

  function addBlock(type: string) {
    if (!selected) return;
    const defaults: Record<string, Record<string, unknown>> = {
      heading: { level: 2, text: 'New heading' },
      text:    { html: '<p>Your text here.</p>' },
      image:   { src: '', alt: '', width: '100%' },
      button:  { label: 'Click me', href: '#', variant: 'primary' },
      divider: {},
      html:    { code: '' },
    };
    selected.blocks = [...selected.blocks, { type, content: defaults[type] ?? {} }];
  }

  function removeBlock(idx: number) {
    if (!selected) return;
    selected.blocks = selected.blocks.filter((_, i) => i !== idx);
  }

  function moveBlock(idx: number, dir: -1 | 1) {
    if (!selected) return;
    const arr = [...selected.blocks];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    selected.blocks = arr;
  }
</script>

<div class="space-y-5">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      {#if view !== 'list'}
        <button class="btn btn-ghost btn-sm" onclick={() => { view = 'list'; selected = null; }}>← Back</button>
        <span class="text-base-content/30">/</span>
      {/if}
      <div>
        <h1 class="text-xl font-semibold">Page Builder</h1>
        {#if selected && view === 'edit'}
          <p class="text-sm text-base-content/50">/{selected.slug}</p>
        {/if}
      </div>
    </div>
    {#if view === 'list'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showNew = !showNew)}>
        <Plus size={14}/> New Page
      </button>
    {:else if view === 'edit' && selected}
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm gap-1" onclick={toggleStatus}>
          {#if selected.status === 'published'}
            <EyeOff size={14}/> Unpublish
          {:else}
            <Eye size={14}/> Publish
          {/if}
        </button>
        <button class="btn btn-primary btn-sm gap-1" onclick={savePage} disabled={saving}>
          {#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<Save size={14}/>{/if}
          Save
        </button>
      </div>
    {/if}
  </div>

  <!-- Create form -->
  {#if showNew && view === 'list'}
    <div class="card bg-base-200 border border-primary/30">
      <div class="card-body p-4 gap-3">
        <h4 class="font-semibold text-sm">New Page</h4>
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Title *</span></label>
            <input type="text" class="input input-sm" placeholder="e.g. About Us"
              bind:value={form.title}
              oninput={(e) => {
                form.title = e.currentTarget.value;
                if (!form.slug || form.slug === slugify(form.title))
                  form.slug = slugify(e.currentTarget.value);
              }}/>
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Slug *</span></label>
            <input type="text" class="input input-sm font-mono" bind:value={form.slug}/>
          </div>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm gap-1" onclick={createPage} disabled={!form.title.trim() || !form.slug.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin"/>{:else}<Plus size={13}/>{/if}
            Create
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => (showNew = false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- List view -->
  {#if view === 'list'}
    {#if loading}
      <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary"/></div>
    {:else if pages.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center text-center py-16 gap-3">
          <FileText size={36} class="text-base-content/20"/>
          <p class="font-medium text-sm text-base-content/50">No pages yet</p>
          <p class="text-xs text-base-content/40">Create your first page to get started.</p>
        </div>
      </div>
    {:else}
      <div class="space-y-2">
        {#each pages as p (p.id)}
          <div class="card bg-base-200 hover:bg-base-300 transition-colors">
            <div class="card-body p-3 flex-row items-center gap-3">
              <FileText size={16} class="text-primary shrink-0"/>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <p class="font-medium text-sm truncate">{p.title}</p>
                  <span class="badge badge-xs {p.status === 'published' ? 'badge-success' : 'badge-ghost'}">{p.status}</span>
                </div>
                <p class="text-xs text-base-content/40 font-mono">/{p.slug}</p>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button class="btn btn-ghost btn-xs" onclick={() => openEdit(p)}>Edit</button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deletePage(p.id)}>
                  <Trash2 size={13}/>
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

  <!-- Edit view -->
  {:else if view === 'edit' && selected}
    <div class="grid lg:grid-cols-3 gap-4">

      <!-- Block canvas -->
      <div class="lg:col-span-2 space-y-3">
        <p class="text-xs font-medium text-base-content/50 uppercase tracking-wider">Blocks</p>
        {#each selected.blocks as block, idx (idx)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center gap-2">
                <span class="badge badge-ghost badge-sm font-mono">{block.type}</span>
                <div class="flex-1"></div>
                <button class="btn btn-ghost btn-xs" onclick={() => moveBlock(idx, -1)} disabled={idx === 0}>↑</button>
                <button class="btn btn-ghost btn-xs" onclick={() => moveBlock(idx, 1)} disabled={idx === selected.blocks.length - 1}>↓</button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => removeBlock(idx)}><Trash2 size={12}/></button>
              </div>
              {#if block.type === 'heading'}
                <input type="text" class="input input-sm" bind:value={(block.content as any).text} placeholder="Heading text"/>
              {:else if block.type === 'text'}
                <textarea class="textarea textarea-sm h-24 text-sm" bind:value={(block.content as any).html} placeholder="<p>Your text…</p>"></textarea>
              {:else if block.type === 'image'}
                <input type="url" class="input input-sm" bind:value={(block.content as any).src} placeholder="Image URL"/>
                <input type="text" class="input input-sm" bind:value={(block.content as any).alt} placeholder="Alt text"/>
              {:else if block.type === 'button'}
                <div class="flex gap-2">
                  <input type="text" class="input input-sm flex-1" bind:value={(block.content as any).label} placeholder="Button label"/>
                  <input type="text" class="input input-sm flex-1" bind:value={(block.content as any).href} placeholder="URL or #anchor"/>
                </div>
              {:else if block.type === 'html'}
                <textarea class="textarea textarea-sm h-24 font-mono text-xs" bind:value={(block.content as any).code} placeholder="<div>Custom HTML…</div>"></textarea>
              {:else}
                <p class="text-xs text-base-content/40 italic">No editor for block type "{block.type}"</p>
              {/if}
            </div>
          </div>
        {:else}
          <div class="card bg-base-200 border border-dashed border-base-300">
            <div class="card-body items-center py-10 text-center gap-2">
              <p class="text-sm text-base-content/40">No blocks yet. Add one below.</p>
            </div>
          </div>
        {/each}

        <!-- Add block -->
        <div class="flex flex-wrap gap-2">
          {#each BLOCK_TYPES as bt}
            <button class="btn btn-outline btn-xs gap-1" onclick={() => addBlock(bt)}>
              <Plus size={11}/> {bt}
            </button>
          {/each}
        </div>
      </div>

      <!-- Page settings sidebar -->
      <div class="space-y-4">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-3">
            <p class="text-xs font-medium text-base-content/70 uppercase tracking-wider">Page Settings</p>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">Title</span></label>
              <input type="text" class="input input-sm" bind:value={selected.title}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">Slug</span></label>
              <input type="text" class="input input-sm font-mono" bind:value={selected.slug}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">Meta title</span></label>
              <input type="text" class="input input-sm" bind:value={selected.meta_title}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">Meta description</span></label>
              <textarea class="textarea textarea-sm text-xs h-16" bind:value={selected.meta_description}></textarea>
            </div>
            <div class="flex items-center gap-2 pt-1">
              <span class="text-xs text-base-content/60">Status:</span>
              <span class="badge badge-sm {selected.status === 'published' ? 'badge-success' : 'badge-ghost'}">{selected.status}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
