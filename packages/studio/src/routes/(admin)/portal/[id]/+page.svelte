<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { portalApi, collectionsApi } from '$lib/api.js';
  import {
    ArrowLeft, Plus, Trash2, GripVertical, Save, Settings2,
    LayoutGrid, Table2, BarChart, AlignLeft, Code2, Columns3,
    LoaderCircle, ChevronDown, ChevronUp, Eye, EyeOff,
  } from '@lucide/svelte';

  interface Section {
    id: string;
    title?: string;
    view_type: string;
    config: Record<string, any>;
    col_span: number;
    sort_order: number;
    is_visible: boolean;
    collection_view_id?: string;
  }

  interface CollectionView {
    id: string;
    name: string;
    collection: string;
    view_type: string;
  }

  const pageId = $derived(page.params.id ?? '');

  let portalPage = $state<any>(null);
  let sections = $state<Section[]>([]);
  let collectionViews = $state<CollectionView[]>([]);
  let collections = $state<any[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let expandedSection = $state<string | null>(null);

  // New section form
  let showAddSection = $state(false);
  let newSection = $state({
    title: '',
    view_type: 'collection',
    col_span: 12,
    collection_view_id: '',
  });

  const VIEW_TYPES = [
    { value: 'collection', label: 'Collection View', icon: Table2 },
    { value: 'hero',       label: 'Hero Banner',     icon: AlignLeft },
    { value: 'markdown',   label: 'Markdown / HTML', icon: Code2 },
    { value: 'stats',      label: 'Stats Cards',     icon: BarChart },
    { value: 'grid',       label: 'Custom Grid',     icon: LayoutGrid },
    { value: 'columns',    label: 'Columns',         icon: Columns3 },
  ];

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      const [pagesRes, sectionsRes, colRes] = await Promise.all([
        portalApi.listPages(),
        portalApi.listSections(pageId),
        collectionsApi.list(),
      ]);
      portalPage = pagesRes.pages?.find((p: any) => p.id === pageId) ?? null;
      sections = (sectionsRes.sections ?? []).sort((a: Section, b: Section) => a.sort_order - b.sort_order);
      collections = colRes.collections ?? [];

      // Load collection views for all collections
      const viewsArrays = await Promise.all(
        collections.map(c => portalApi.listViews(c.name).then(r => r.views ?? []).catch(() => []))
      );
      collectionViews = viewsArrays.flat();
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function addSection() {
    if (!newSection.view_type) return;
    saving = true;
    try {
      const payload: any = {
        title: newSection.title || undefined,
        view_type: newSection.view_type,
        col_span: newSection.col_span,
        config: {},
        is_visible: true,
      };
      if (newSection.view_type === 'collection' && newSection.collection_view_id) {
        payload.collection_view_id = newSection.collection_view_id;
      }
      const res = await portalApi.createSection(pageId, payload);
      sections = [...sections, res.section];
      showAddSection = false;
      newSection = { title: '', view_type: 'collection', col_span: 12, collection_view_id: '' };
      expandedSection = res.section.id;
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  async function deleteSection(id: string) {
    if (!confirm('Delete this section?')) return;
    try {
      await portalApi.deleteSection(id);
      sections = sections.filter(s => s.id !== id);
    } catch (e: any) {
      error = e.message;
    }
  }

  async function toggleVisible(s: Section) {
    try {
      const res = await portalApi.updateSection(s.id, { is_visible: !s.is_visible });
      sections = sections.map(x => x.id === s.id ? res.section : x);
    } catch (e: any) {
      error = e.message;
    }
  }

  async function saveSection(s: Section) {
    saving = true;
    try {
      const res = await portalApi.updateSection(s.id, {
        title: s.title,
        col_span: s.col_span,
        config: s.config,
        is_visible: s.is_visible,
      });
      sections = sections.map(x => x.id === s.id ? res.section : x);
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  async function moveSection(idx: number, dir: -1 | 1) {
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sections.length) return;
    const next = [...sections];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    sections = next;
    // Persist reorder
    await portalApi.reorderSections(pageId, sections.map(s => s.id)).catch(() => {});
  }

  function viewTypeLabel(vt: string) {
    return VIEW_TYPES.find(v => v.value === vt)?.label ?? vt;
  }

  function collectionViewLabel(cvId: string) {
    const cv = collectionViews.find(v => v.id === cvId);
    return cv ? `${cv.collection} / ${cv.name}` : cvId;
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <a href="{base}/portal" class="btn btn-ghost btn-sm"><ArrowLeft size={16}/></a>
    <div class="flex-1 min-w-0">
      {#if portalPage}
        <h1 class="text-2xl font-bold truncate">{portalPage.title}</h1>
        <p class="text-base-content/50 text-sm font-mono">/{portalPage.slug}</p>
      {:else if loading}
        <div class="skeleton h-7 w-48 rounded"/>
      {:else}
        <h1 class="text-2xl font-bold">Page Editor</h1>
      {/if}
    </div>
    <a href="{base}/portal/theme" class="btn btn-ghost btn-sm gap-1">
      <Settings2 size={15}/> Theme
    </a>
  </div>

  {#if error}
    <div class="alert alert-error text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={32} class="animate-spin text-primary"/>
    </div>
  {:else}
    <!-- Sections list -->
    <div class="flex flex-col gap-3">
      {#each sections as section, idx (section.id)}
        <div class="card bg-base-200 border border-base-300 {!section.is_visible ? 'opacity-60' : ''}">
          <!-- Section header -->
          <div class="flex items-center gap-2 px-4 py-3">
            <!-- Reorder -->
            <div class="flex flex-col gap-0.5">
              <button class="btn btn-ghost btn-xs p-0.5 h-auto min-h-0" onclick={() => moveSection(idx, -1)} disabled={idx === 0}>
                <ChevronUp size={13}/>
              </button>
              <button class="btn btn-ghost btn-xs p-0.5 h-auto min-h-0" onclick={() => moveSection(idx, 1)} disabled={idx === sections.length - 1}>
                <ChevronDown size={13}/>
              </button>
            </div>

            <div class="flex-1 min-w-0">
              <p class="font-medium text-sm truncate">
                {section.title || viewTypeLabel(section.view_type)}
              </p>
              <p class="text-xs text-base-content/40">
                {viewTypeLabel(section.view_type)}
                {#if section.collection_view_id}
                  · {collectionViewLabel(section.collection_view_id)}
                {/if}
                · {section.col_span === 12 ? 'full width' : `${section.col_span}/12 cols`}
              </p>
            </div>

            <div class="flex gap-1 shrink-0">
              <button class="btn btn-ghost btn-xs" onclick={() => toggleVisible(section)} title={section.is_visible ? 'Hide' : 'Show'}>
                {#if section.is_visible}<Eye size={13} class="text-success"/>{:else}<EyeOff size={13} class="opacity-40"/>{/if}
              </button>
              <button
                class="btn btn-ghost btn-xs"
                onclick={() => expandedSection = expandedSection === section.id ? null : section.id}
              >
                <Settings2 size={13}/>
              </button>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteSection(section.id)}>
                <Trash2 size={13}/>
              </button>
            </div>
          </div>

          <!-- Expanded config panel -->
          {#if expandedSection === section.id}
            <div class="border-t border-base-300 px-4 py-3 space-y-3 bg-base-100">
              <div class="grid grid-cols-2 gap-3">
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Section title</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="Optional heading…"
                    bind:value={section.title}/>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Column span (1–12)</span></label>
                  <input type="number" class="input input-sm input-bordered" min={1} max={12}
                    bind:value={section.col_span}/>
                </div>
              </div>

              {#if section.view_type === 'collection'}
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Collection View</span></label>
                  <select class="select select-sm select-bordered" bind:value={section.collection_view_id}>
                    <option value="">— select a view —</option>
                    {#each collections as col}
                      {@const views = collectionViews.filter(v => v.collection === col.name)}
                      {#if views.length > 0}
                        <optgroup label={col.display_name ?? col.name}>
                          {#each views as v}
                            <option value={v.id}>{v.name}</option>
                          {/each}
                        </optgroup>
                      {/if}
                    {/each}
                  </select>
                </div>
              {:else if section.view_type === 'hero'}
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Heading</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="Welcome to My App"
                    bind:value={section.config.heading}/>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Subheading</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="Subtitle or tagline…"
                    bind:value={section.config.subheading}/>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Button label</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="Get Started"
                    bind:value={section.config.button_label}/>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Button URL</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="/collections/posts"
                    bind:value={section.config.button_url}/>
                </div>
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Background image URL</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="https://…"
                    bind:value={section.config.bg_image}/>
                </div>
              {:else if section.view_type === 'markdown'}
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Markdown / HTML content</span></label>
                  <textarea class="textarea textarea-bordered text-xs font-mono" rows={8}
                    bind:value={section.config.content}></textarea>
                </div>
              {:else if section.view_type === 'stats'}
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Collections (comma-separated)</span></label>
                  <input type="text" class="input input-sm input-bordered"
                    placeholder="posts, users, products"
                    bind:value={section.config.collections}/>
                </div>
              {:else}
                <!-- Generic JSON config editor -->
                <div class="form-control">
                  <label class="label py-0.5"><span class="label-text text-xs">Config (JSON)</span></label>
                  <textarea class="textarea textarea-bordered text-xs font-mono" rows={5}
                    value={JSON.stringify(section.config, null, 2)}
                    oninput={(e) => {
                      try { section.config = JSON.parse((e.target as HTMLTextAreaElement).value); } catch {}
                    }}></textarea>
                </div>
              {/if}

              <div class="flex justify-end pt-1">
                <button class="btn btn-primary btn-sm gap-1" onclick={() => saveSection(section)} disabled={saving}>
                  {#if saving}<LoaderCircle size={13} class="animate-spin"/>{:else}<Save size={13}/>{/if}
                  Save Section
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/each}

      {#if sections.length === 0}
        <div class="text-center py-12 text-base-content/40 border-2 border-dashed border-base-300 rounded-xl">
          <LayoutGrid size={36} class="mx-auto mb-2 opacity-30"/>
          <p class="text-sm">No sections yet — add one below</p>
        </div>
      {/if}
    </div>

    <!-- Add section -->
    {#if showAddSection}
      <div class="card bg-base-200 border border-primary/40">
        <div class="card-body p-4 space-y-3">
          <h3 class="font-semibold text-sm">Add Section</h3>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {#each VIEW_TYPES as vt}
              <button
                class="btn btn-sm gap-1 justify-start"
                class:btn-primary={newSection.view_type === vt.value}
                class:btn-outline={newSection.view_type !== vt.value}
                onclick={() => newSection.view_type = vt.value}
              >
                <vt.icon size={13}/>
                {vt.label}
              </button>
            {/each}
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">Title (optional)</span></label>
              <input type="text" class="input input-sm input-bordered" placeholder="Section heading…"
                bind:value={newSection.title}/>
            </div>
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">Column span</span></label>
              <select class="select select-sm select-bordered" bind:value={newSection.col_span}>
                <option value={12}>Full width (12)</option>
                <option value={6}>Half (6)</option>
                <option value={4}>One-third (4)</option>
                <option value={3}>One-quarter (3)</option>
                <option value={8}>Two-thirds (8)</option>
              </select>
            </div>
          </div>

          {#if newSection.view_type === 'collection'}
            <div class="form-control">
              <label class="label py-0.5"><span class="label-text text-xs">Collection View</span></label>
              <select class="select select-sm select-bordered" bind:value={newSection.collection_view_id}>
                <option value="">— select a view —</option>
                {#each collections as col}
                  {@const views = collectionViews.filter(v => v.collection === col.name)}
                  {#if views.length > 0}
                    <optgroup label={col.display_name ?? col.name}>
                      {#each views as v}
                        <option value={v.id}>{v.name}</option>
                      {/each}
                    </optgroup>
                  {/if}
                {/each}
              </select>
            </div>
          {/if}

          <div class="flex justify-end gap-2">
            <button class="btn btn-ghost btn-sm" onclick={() => showAddSection = false}>Cancel</button>
            <button class="btn btn-primary btn-sm gap-1" onclick={addSection} disabled={saving}>
              {#if saving}<LoaderCircle size={13} class="animate-spin"/>{:else}<Plus size={13}/>{/if}
              Add Section
            </button>
          </div>
        </div>
      </div>
    {:else}
      <button class="btn btn-outline btn-sm gap-1 w-full" onclick={() => showAddSection = true}>
        <Plus size={14}/> Add Section
      </button>
    {/if}
  {/if}
</div>
