<script lang="ts">
/**
 * The page-builder canvas for one page of `content/pages`: a front-end package
 * of Studio (ADR 0042 decision 9), drawn instead of the extension's
 * `pages.builder` view (see `#lib/code-screens.ts`). It reads and writes only
 * through the data API and the extension's `publish` action, as the user.
 */
import { onDestroy, onMount } from 'svelte';
import { resolve } from '$app/paths';
import { ArrowLeft, Monitor, Save, Smartphone, Tablet, Undo2, Redo2 } from '@lucide/svelte';
import { api } from '#lib/api.js';
import { m } from '#lib/i18n.svelte.js';
import { toast } from '#lib/stores/toast.svelte.js';
import type { Block } from '#lib/page-builder/lib/builder-types.js';
import {
  ensureIds,
  findById,
  insertAt,
  isContainer,
  patchById,
  removeById,
} from '#lib/page-builder/lib/block-tree.js';
import { BREAKPOINT_LABEL, type Breakpoint } from '#lib/page-builder/lib/breakpoints.js';
import BlockLibrary from '#lib/page-builder/components/builder/BlockLibrary.svelte';
import Canvas from '#lib/page-builder/components/builder/Canvas.svelte';
import PropertiesPanel from '#lib/page-builder/components/builder/PropertiesPanel.svelte';

const PAGES = '/api/data/pages';
const EXT = '/ext/content/pages';

type PageMeta = {
  id: string;
  title: string;
  slug: string;
  blocks?: Block[] | string;
};

/** The view's parameters: the page path's `:id`. */
let { params }: { params: Record<string, string> } = $props();

const pageId = $derived(params.id ?? '');

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
    meta = await api.get<PageMeta>(`${PAGES}/${pageId}`);
    if (!meta) throw new Error('Page not found');
    const raw =
      typeof meta.blocks === 'string' ? JSON.parse(meta.blocks || '[]') : (meta.blocks ?? []);
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
      // The fallback is typed, not bare: `.catch(() => ({}))` widens the result
      // to `{…} | {}`, and neither `icons` nor `motion` exists on `{}` — so the
      // two reads below were type errors that nothing ran.
      api
        .get<{ icons?: string[]; motion?: string[] }>(`${EXT}/vocabulary`)
        .catch((): { icons?: string[]; motion?: string[] } => ({})),
      api
        .get<{ collections?: Array<{ name: string; fields?: Array<{ name: string }> }> }>(
          '/api/collections',
        )
        .catch(() => ({ collections: [] })),
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

/** Save the draft; `publish` then snapshots it for the site (the `publish` action). */
async function savePage(publish = false): Promise<void> {
  if (!meta || saving) return;
  saving = true;
  try {
    await api.patch(`${PAGES}/${meta.id}`, { blocks });
    if (publish) await api.post(`${EXT}/actions/publish`, { id: meta.id });
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
    <a href={resolve('pages')} class="btn btn-ghost btn-sm gap-1" aria-label="Back">
      <ArrowLeft size={14} />
      <span class="hidden sm:inline">Pages</span>
    </a>
    <div class="min-w-0 flex-1">
      {#if meta}
        <div class="font-medium text-sm truncate">{meta.title}</div>
        <div class="text-xs opacity-50 font-mono truncate">/{meta.slug}</div>
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
    <button type="button" class="btn btn-success btn-sm" disabled={saving || !meta} onclick={() => void savePage(true)}>
      {m['common.publish']?.() ?? 'Publish'}
    </button>
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
