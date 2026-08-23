<script lang="ts">
/**
 * Page block builder — Tier-3 canvas for a single page (by UUID).
 */
import { onDestroy, onMount } from 'svelte';
import { page } from '$app/state';
import { base } from '$app/paths';
import { ArrowLeft, Monitor, Save, Smartphone, Tablet, Undo2, Redo2 } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';
import type { Block } from '$lib/ext/content/pages/lib/builder-types.js';
import {
  ensureIds,
  findById,
  insertAt,
  isContainer,
  patchById,
  removeById,
} from '$lib/ext/content/pages/lib/block-tree.js';
import { BREAKPOINT_LABEL, type Breakpoint } from '$lib/ext/content/pages/lib/breakpoints.js';
import BlockLibrary from '$lib/ext/content/pages/components/builder/BlockLibrary.svelte';
import Canvas from '$lib/ext/content/pages/components/builder/Canvas.svelte';
import PropertiesPanel from '$lib/ext/content/pages/components/builder/PropertiesPanel.svelte';

const BASE = '/ext/content/pages/pages';

type PageMeta = {
  id: string;
  title: string;
  slug: string;
  status: string;
  blocks?: Block[] | string;
};

const pageId = $derived(page.params.id ?? '');

let meta = $state<PageMeta | null>(null);
let blocks = $state<Block[]>([]);
let selectedId = $state<string | null>(null);
let device = $state<Breakpoint>('base');
let history = $state<Block[][]>([]);
let future = $state<Block[][]>([]);
let loading = $state(true);
let saving = $state(false);
let collections = $state<string[]>([]);
let collectionFields = $state<Record<string, string[]>>({});
let iconNames = $state<string[]>([]);
let motionTypes = $state<string[]>([]);

const selectedBlock = $derived(findById(blocks, selectedId));

function commit(next: Block[]) {
  history = [...history, blocks];
  future = [];
  blocks = next;
}

function undo() {
  if (!history.length) return;
  future = [blocks, ...future];
  blocks = history[history.length - 1]!;
  history = history.slice(0, -1);
}

function redo() {
  if (!future.length) return;
  history = [...history, blocks];
  blocks = future[0]!;
  future = future.slice(1);
}

function onAdd(block: Block) {
  const selectedBlk = findById(blocks, selectedId);
  if (selectedBlk && isContainer(selectedBlk)) {
    const kids = (selectedBlk.content?.children ?? []) as Block[];
    commit(insertAt(blocks, selectedBlk.id, kids.length, block));
  } else {
    commit(insertAt(blocks, null, blocks.length, block));
  }
  selectedId = block.id;
}

function onPatch(fn: (b: Block) => Block) {
  if (!selectedId) return;
  commit(patchById(blocks, selectedId, fn));
}

async function loadPage(): Promise<void> {
  if (!pageId) return;
  loading = true;
  try {
    const r = await api.get<{ page?: PageMeta }>(`${BASE}/${pageId}`);
    meta = r.page ?? null;
    if (!meta) throw new Error('Page not found');
    const raw = typeof meta.blocks === 'string' ? JSON.parse(meta.blocks || '[]') : (meta.blocks ?? []);
    blocks = ensureIds(Array.isArray(raw) ? raw : []);
    history = [];
    future = [];
    selectedId = null;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to load page');
    meta = null;
  } finally {
    loading = false;
  }
}

async function loadExtras(): Promise<void> {
  try {
    const [vocab, cols] = await Promise.all([
      api.get<{ icons?: string[]; motion?: string[] }>(`${BASE}/vocabulary`).catch(() => ({})),
      api.get<{ collections?: Array<{ name: string; fields?: Array<{ name: string }> }> }>(
        '/api/collections',
      ).catch(() => ({ collections: [] })),
    ]);
    iconNames = vocab.icons ?? [];
    motionTypes = vocab.motion ?? [];
    const list = cols.collections ?? [];
    collections = list.map((c) => c.name);
    const fields: Record<string, string[]> = {};
    for (const c of list) {
      fields[c.name] = (c.fields ?? []).map((f) => f.name);
    }
    collectionFields = fields;
  } catch {
    /* non-fatal */
  }
}

async function savePage(status?: string): Promise<void> {
  if (!meta || saving) return;
  saving = true;
  try {
    const r = await api.put<{ page?: PageMeta }>(`${BASE}/${meta.id}`, {
      title: meta.title,
      slug: meta.slug,
      blocks,
      status: status ?? meta.status,
    });
    if (r.page) meta = { ...meta, ...r.page };
    toast.success(m['common.saved']?.() ?? 'Saved');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Save failed');
  } finally {
    saving = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
    return;
  }
  if (mod && e.key === 's') {
    e.preventDefault();
    void savePage();
    return;
  }
  if (e.key === 'Escape') {
    selectedId = null;
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
    e.preventDefault();
    commit(removeById(blocks, selectedId));
    selectedId = null;
  }
}

$effect(() => {
  void pageId;
  void loadPage();
});

onMount(() => {
  void loadExtras();
  window.addEventListener('keydown', onKeydown);
});
onDestroy(() => window.removeEventListener('keydown', onKeydown));
</script>

<div class="flex flex-col h-[calc(100vh-5rem)] min-h-[32rem]">
  <header class="flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-100 shrink-0 flex-wrap">
    <a href="{base}/pages" class="btn btn-ghost btn-sm gap-1" aria-label="Back">
      <ArrowLeft size={14} />
      <span class="hidden sm:inline">Pages</span>
    </a>
    <div class="min-w-0 flex-1">
      {#if meta}
        <div class="font-medium text-sm truncate">{meta.title}</div>
        <div class="text-xs opacity-50 font-mono truncate">/{meta.slug} · {meta.status}</div>
      {:else}
        <div class="text-sm opacity-50">…</div>
      {/if}
    </div>

    <div class="join">
      <button type="button" class="btn btn-sm join-item {device === 'base' ? 'btn-active' : ''}" onclick={() => (device = 'base')} title={BREAKPOINT_LABEL.base}>
        <Smartphone size={14} />
      </button>
      <button type="button" class="btn btn-sm join-item {device === 'tablet' ? 'btn-active' : ''}" onclick={() => (device = 'tablet')} title={BREAKPOINT_LABEL.tablet}>
        <Tablet size={14} />
      </button>
      <button type="button" class="btn btn-sm join-item {device === 'desktop' ? 'btn-active' : ''}" onclick={() => (device = 'desktop')} title={BREAKPOINT_LABEL.desktop}>
        <Monitor size={14} />
      </button>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" disabled={!history.length} onclick={undo} aria-label="Undo">
      <Undo2 size={14} />
    </button>
    <button type="button" class="btn btn-ghost btn-sm" disabled={!future.length} onclick={redo} aria-label="Redo">
      <Redo2 size={14} />
    </button>

    <button type="button" class="btn btn-primary btn-sm gap-1" disabled={saving || !meta} onclick={() => void savePage()}>
      <Save size={14} />
      {saving ? '…' : (m['common.save']?.() ?? 'Save')}
    </button>
    {#if meta?.status !== 'published'}
      <button type="button" class="btn btn-success btn-sm" disabled={saving || !meta} onclick={() => void savePage('published')}>
        Publish
      </button>
    {/if}
  </header>

  {#if loading}
    <div class="flex-1 flex items-center justify-center">
      <span class="loading loading-spinner loading-lg opacity-40"></span>
    </div>
  {:else if !meta}
    <div class="flex-1 flex items-center justify-center text-sm opacity-60">Page not found</div>
  {:else}
    <div class="flex-1 flex min-h-0">
      <aside class="w-56 shrink-0 border-r border-base-300 overflow-y-auto bg-base-200/30">
        <BlockLibrary {onAdd} />
      </aside>
      <div class="flex-1 min-w-0 overflow-auto bg-base-200/20">
        <Canvas
          {blocks}
          {selectedId}
          {device}
          onChange={commit}
          onSelect={(id) => (selectedId = id)}
        />
      </div>
      <aside class="w-72 shrink-0 border-l border-base-300 overflow-y-auto bg-base-100">
        {#if selectedBlock}
          <PropertiesPanel
            block={selectedBlock}
            {onPatch}
            {collections}
            {collectionFields}
            {device}
            {iconNames}
            {motionTypes}
          />
        {:else}
          <div class="p-4 text-sm opacity-50">Select a block to edit its properties.</div>
        {/if}
      </aside>
    </div>
  {/if}
</div>
