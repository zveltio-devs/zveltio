<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import {
    Plus, Trash2, Save, LoaderCircle, Eye, EyeOff, FileText, Database,
  } from '@lucide/svelte';

  type Block = { type: string; content: Record<string, unknown> };
  type Page = {
    id: string; title: string; slug: string; blocks: Block[];
    meta: Record<string, string> | null;
    status: 'draft' | 'published'; created_at: string; updated_at: string;
    published_at: string | null;
  };
  type CollectionMeta = { name: string; label?: string };
  type Filter = { field: string; op: string; value: string };

  let pages = $state<Page[]>([]);
  let loading = $state(true);
  let selected = $state<Page | null>(null);
  let view = $state<'list' | 'edit'>('list');
  let saving = $state(false);
  let showNew = $state(false);
  let form = $state({ title: '', slug: '' });
  let collections = $state<CollectionMeta[]>([]);

  const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'html', 'collection_list'];
  const FILTER_OPS = ['eq','neq','like','gt','gte','lt','lte','is_null','is_not_null'];

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
      const [pRes, cRes] = await Promise.all([
        api.get<{ pages: Page[] }>('/api/ext/pages'),
        api.get<{ collections: CollectionMeta[] }>('/api/collections').catch(() => ({ collections: [] })),
      ]);
      pages = pRes.pages ?? [];
      collections = cRes.collections ?? [];
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      loading = false;
    }
  }

  function blockFilters(block: Block): Filter[] {
    return ((block.content as any).filters ?? []) as Filter[];
  }

  function addFilter(block: Block) {
    (block.content as any).filters = [...blockFilters(block), { field: '', op: 'eq', value: '' }];
    selected = selected; // trigger reactivity
  }

  function removeFilter(block: Block, idx: number) {
    (block.content as any).filters = blockFilters(block).filter((_, i) => i !== idx);
    selected = selected;
  }

  function setFilter(block: Block, idx: number, key: keyof Filter, val: string) {
    const filters = blockFilters(block).map((f, i) => i === idx ? { ...f, [key]: val } : f);
    (block.content as any).filters = filters;
    selected = selected;
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
        meta: selected.meta ?? {},
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
      button:          { label: 'Click me', href: '#', variant: 'primary' },
      divider:         {},
      html:            { code: '' },
      collection_list: {
        collection: '', title: '', limit: 10,
        sort_field: 'created_at', sort_dir: 'desc',
        filters: [], display_fields: '', layout: 'table',
      },
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
              {:else if block.type === 'collection_list'}
                <div class="space-y-3">
                  <!-- Row 1: collection + title -->
                  <div class="grid sm:grid-cols-2 gap-2">
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Collection *</span></label>
                      {#if collections.length > 0}
                        <select class="select select-sm" bind:value={(block.content as any).collection}>
                          <option value="">— pick collection —</option>
                          {#each collections as col}
                            <option value={col.name}>{col.label || col.name}</option>
                          {/each}
                        </select>
                      {:else}
                        <input type="text" class="input input-sm font-mono" bind:value={(block.content as any).collection} placeholder="collection_name"/>
                      {/if}
                    </div>
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Section title</span></label>
                      <input type="text" class="input input-sm" bind:value={(block.content as any).title} placeholder="e.g. Ultimele controale"/>
                    </div>
                  </div>
                  <!-- Row 2: limit + sort -->
                  <div class="grid grid-cols-3 gap-2">
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Limit</span></label>
                      <input type="number" class="input input-sm" min="1" max="100" bind:value={(block.content as any).limit}/>
                    </div>
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Sort field</span></label>
                      <input type="text" class="input input-sm font-mono" bind:value={(block.content as any).sort_field} placeholder="created_at"/>
                    </div>
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Direction</span></label>
                      <select class="select select-sm" bind:value={(block.content as any).sort_dir}>
                        <option value="desc">desc</option>
                        <option value="asc">asc</option>
                      </select>
                    </div>
                  </div>
                  <!-- Row 3: display fields + layout -->
                  <div class="grid sm:grid-cols-2 gap-2">
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Display fields <span class="text-base-content/40">(comma-sep, empty = all)</span></span></label>
                      <input type="text" class="input input-sm font-mono" bind:value={(block.content as any).display_fields} placeholder="id, name, status, date"/>
                    </div>
                    <div class="form-control gap-1">
                      <label class="label py-0"><span class="label-text text-xs">Layout</span></label>
                      <select class="select select-sm" bind:value={(block.content as any).layout}>
                        <option value="table">Table</option>
                        <option value="cards">Cards</option>
                        <option value="list">List</option>
                      </select>
                    </div>
                  </div>
                  <!-- Filters -->
                  <div>
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-xs font-medium text-base-content/60">Filters</span>
                      <button class="btn btn-ghost btn-xs gap-1" onclick={() => addFilter(block)}>
                        <Plus size={11}/> Add filter
                      </button>
                    </div>
                    {#each blockFilters(block) as f, fi}
                      <div class="flex gap-1.5 mb-1.5 items-center">
                        <input type="text" class="input input-xs font-mono flex-1" placeholder="field"
                          value={f.field} oninput={(e) => setFilter(block, fi, 'field', e.currentTarget.value)}/>
                        <select class="select select-xs w-28"
                          value={f.op} onchange={(e) => setFilter(block, fi, 'op', e.currentTarget.value)}>
                          {#each FILTER_OPS as op}<option value={op}>{op}</option>{/each}
                        </select>
                        {#if f.op !== 'is_null' && f.op !== 'is_not_null'}
                          <input type="text" class="input input-xs flex-1" placeholder="value"
                            value={f.value} oninput={(e) => setFilter(block, fi, 'value', e.currentTarget.value)}/>
                        {/if}
                        <button class="btn btn-ghost btn-xs text-error" onclick={() => removeFilter(block, fi)}><Trash2 size={11}/></button>
                      </div>
                    {/each}
                    {#if blockFilters(block).length === 0}
                      <p class="text-xs text-base-content/30 italic">No filters — all records returned</p>
                    {/if}
                  </div>
                  <!-- Preview badge -->
                  <div class="flex items-center gap-1.5 pt-1">
                    <Database size={12} class="text-primary"/>
                    <span class="text-xs text-primary font-medium">
                      {(block.content as any).collection
                        ? `Live data from "${(block.content as any).collection}" — rendered by client`
                        : 'Pick a collection above'}
                    </span>
                  </div>
                </div>
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
              <input type="text" class="input input-sm"
                value={selected.meta?.title ?? ''}
                oninput={(e) => { selected!.meta = { ...selected!.meta, title: e.currentTarget.value }; }}/>
            </div>
            <div class="form-control gap-1">
              <label class="label py-0"><span class="label-text text-xs">Meta description</span></label>
              <textarea class="textarea textarea-sm text-xs h-16"
                value={selected.meta?.description ?? ''}
                oninput={(e) => { selected!.meta = { ...selected!.meta, description: e.currentTarget.value }; }}></textarea>
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
