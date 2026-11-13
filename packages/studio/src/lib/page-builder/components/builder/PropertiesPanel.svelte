<script lang="ts">
import { m } from '#lib/i18n.svelte.js';
import {
  type Block,
  type BlockStyle,
  type ContentFilter,
  fieldsOf,
  asStat,
  asText,
} from '../../lib/builder-types.js';
import { BREAKPOINT_LABEL, spanKey, styleKey, type Breakpoint } from '../../lib/breakpoints.js';
import { Image as ImageIcon, X as XIcon } from '@lucide/svelte';

// Collections come from the parent, which already loaded them through
// `$lib/api.js`. This panel used to `fetch('/api/collections')` itself, which
// goes around the Studio's api wrapper (base path, credentials, error
// envelope) and loaded the same list a second time.
let {
  block,
  onPatch,
  collections = [],
  collectionFields = {},
  device = 'base',
  iconNames = [],
  motionTypes = [],
}: {
  block: Block;
  onPatch: (fn: (b: Block) => Block) => void;
  collections?: string[];
  /** Column names per collection, so a template can name fields that exist. */
  collectionFields?: Record<string, string[]>;
  /** Which device the Style tab is editing — the canvas switcher decides. */
  device?: Breakpoint;
  /** Served by the engine from the renderer's own lists — see /vocabulary. */
  iconNames?: string[];
  motionTypes?: string[];
} = $props();

let tab = $state<'content' | 'style'>('content');

// ── Media picker ────────────────────────────────────────────────────────
//
// `content/media` is installed on most instances and the image and gallery
// blocks took a pasted URL — the most obvious rough edge in the editor. The
// picker opens on demand and degrades to the plain URL field when the
// extension is absent, so this panel never depends on it being there.
type MediaFile = {
  id: string;
  url: string | null;
  storage_path: string;
  original_name: string;
  mimetype: string;
};
let picker = $state<{ open: boolean; target: string | null }>({ open: false, target: null });
let mediaFiles = $state<MediaFile[]>([]);
let mediaState = $state<'idle' | 'loading' | 'unavailable'>('idle');

async function openPicker(target: string) {
  picker = { open: true, target };
  if (mediaFiles.length > 0 || mediaState === 'unavailable') return;
  mediaState = 'loading';
  try {
    // The engine's storage (content/media 2.0.0 no longer serves files).
    const res = await fetch('/api/storage?limit=200', { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    mediaFiles = ((json.files ?? []) as MediaFile[])
      .filter((f) => f.mimetype?.startsWith('image/'))
      .slice(0, 60);
    mediaState = 'idle';
  } catch {
    // Not installed, or not permitted. Either way the URL field still works.
    mediaState = 'unavailable';
  }
}

/** A file's public address — `url` when storage exposes one, else the path. */
function mediaUrl(f: MediaFile): string {
  return f.url ?? `/files/${f.storage_path}`;
}

function chooseMedia(f: MediaFile) {
  if (picker.target) patchContent(picker.target, mediaUrl(f));
  picker = { open: false, target: null };
}

function patchContent(key: string, value: unknown) {
  onPatch((b) => ({ ...b, content: { ...b.content, [key]: value } }));
}

/**
 * Style edits land in the bag for the size currently previewed. Editing at
 * `All sizes` sets the base; switching to Tablet and changing padding leaves
 * the base alone and overrides from 640px up.
 */
function patchStyle(key: keyof BlockStyle, value: BlockStyle[keyof BlockStyle] | '') {
  const v = value === '' ? undefined : value;
  const slot = styleKey(device);
  onPatch((b) => ({ ...b, [slot]: { ...((b[slot] as BlockStyle | undefined) ?? {}), [key]: v } }));
}

/** The style bag being edited, and the value shown for a property. */
const activeStyle = $derived((block[styleKey(device)] as BlockStyle | undefined) ?? {});
const activeSpan = $derived(block[spanKey(device)] as number | undefined);

/**
 * Motion lives beside `style`, not inside it: it is not per-device. A block
 * that fades in on a phone fades in on a desktop, and offering three copies of
 * that setting would be three chances to leave two of them wrong.
 */
function patchMotion(key: string, value: unknown) {
  onPatch((b) => ({ ...b, motion: { ...(b.motion ?? {}), [key]: value } }));
}

function patchItems(items: unknown[]) {
  onPatch((b) => ({ ...b, content: { ...b.content, items } }));
}

// ── Filters ───────────────────────────────────────────────────────────────
//
// The operator names are the engine's, not this panel's invention: they are
// the cases `buildCondition` implements. `is_null`/`is_not_null` are page-
// builder's older spelling and the resolver translates them, but new filters
// are written in the engine's own vocabulary so the two never diverge again.

const FILTER_OPS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'ilike', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less or equal' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'null', label: 'is empty' },
  { value: 'not_null', label: 'is not empty' },
] as const;

/** Operators that take no value — showing a value box for them invites nonsense. */
const UNARY_OPS = new Set(['null', 'not_null']);
/** Operators whose value is a list. */
const LIST_OPS = new Set(['in', 'not_in']);

function patchFilter(index: number, patch: Record<string, unknown>) {
  const next: ContentFilter[] = [...(p.filters ?? [])];
  next[index] = { ...next[index], ...patch };
  // Switching to a unary operator drops a value that would now be meaningless.
  if (typeof patch.op === 'string' && UNARY_OPS.has(patch.op)) delete next[index].value;
  onPatch((b) => ({ ...b, content: { ...b.content, filters: next } }));
}

/** `in`/`not_in` hold arrays; everything else holds a scalar. */
function parseValue(op: string, raw: string): unknown {
  if (LIST_OPS.has(op))
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return raw;
}

function valueText(f: ContentFilter | undefined): string {
  if (Array.isArray(f?.value)) return f.value.join(', ');
  return f?.value == null ? '' : String(f.value);
}

const p = $derived(fieldsOf(block));
const s = $derived(activeStyle);

/** Columns of the collection this data block reads. */
const fieldNames = $derived(collectionFields[p?.collection as string] ?? []);

/**
 * Copy a placeholder so it can be pasted into any text in the template.
 *
 * Click-to-copy rather than a typed name checked afterwards: a mistyped
 * `{{frist_name}}` renders as blank, which is the right behaviour at render
 * time and invisible at authoring time. Handing over the exact string removes
 * the mistake instead of reporting it — and it needs no parser shared between
 * the editor and the renderer, which the two sync scripts cannot carry.
 */
let copied = $state<string | null>(null);
async function copyField(name: string) {
  const token = `{{${name}}}`;
  try {
    await navigator.clipboard.writeText(token);
    copied = name;
    setTimeout(() => {
      if (copied === name) copied = null;
    }, 1200);
  } catch {
    /* clipboard blocked — the chip still shows the exact text to type */
  }
}
</script>

<!--
  A `<span>`, not a `<label>`. This snippet is used as a CAPTION above groups of
  controls as well as beside single ones, so it can never carry a `for` that is
  right in every case — and a `<label>` that names nothing is worse for a screen
  reader than plain text, because it is announced as a label with no target.
-->
{#snippet label(text: string)}
  <span class="block text-[10px] text-base-content/65 mb-0.5">{text}</span>
{/snippet}

{#snippet colorRow(value: string, onInput: (v: string) => void)}
  <div class="flex gap-1 items-center">
    <input type="color" class="h-6 w-8 rounded cursor-pointer border border-base-300 p-0.5 shrink-0"
      value={value || '#000000'}
      oninput={(e) => onInput(e.currentTarget.value)} />
    <input class="input input-xs flex-1 font-mono" value={value}
      oninput={(e) => onInput(e.currentTarget.value)} />
  </div>
{/snippet}

<div class="w-64 shrink-0 bg-base-100 border-l border-base-300 flex flex-col overflow-hidden">

  <!-- Header -->
  <div class="px-3 py-2.5 border-b border-base-300 flex items-center justify-between">
    <span class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest">{m['pageBuilder.properties']()}</span>
    <span class="text-[10px] badge badge-ghost font-mono">{block.type}</span>
  </div>

  <!-- Tabs -->
  <div class="flex border-b border-base-300">
    <button
      class="flex-1 py-2 text-xs font-medium transition-colors
        {tab === 'content' ? 'text-primary border-b-2 border-primary' : 'text-base-content/65 hover:text-base-content'}"
      onclick={() => (tab = 'content')}
    >{m['pageBuilder.tabContent']()}</button>
    <button
      class="flex-1 py-2 text-xs font-medium transition-colors
        {tab === 'style' ? 'text-primary border-b-2 border-primary' : 'text-base-content/65 hover:text-base-content'}"
      onclick={() => (tab = 'style')}
    >{m['pageBuilder.tabStyle']()}</button>
  </div>

  <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3">

    <!-- ── CONTENT TAB ───────────────────────────────────────────────── -->
    {#if tab === 'content'}

      {#if block.type === 'container'}
        <p class="text-[11px] text-base-content/65 leading-snug">
          {m['pageBuilder.containerHint']()}
        </p>
        <div>{@render label(m['pageBuilder.gapBetween']())}
          <select class="select select-xs w-full" value={p.gap ?? 'md'}
            onchange={(e) => patchContent('gap', e.currentTarget.value)}>
            <option value="none">{m['pageBuilder.none']()}</option>
            <option value="sm">{m['pageBuilder.small']()}</option>
            <option value="md">{m['pageBuilder.medium']()}</option>
            <option value="lg">{m['pageBuilder.large']()}</option>
          </select></div>
        <p class="text-[10px] text-base-content/65">
          {(p.children ?? []).length} {m['pageBuilder.blocksInside']()}
        </p>

      {:else if block.type === 'hero'}
        <div>{@render label(m['pageBuilder.title']())}
          <input class="input input-xs w-full" value={p.title ?? ''} oninput={(e) => patchContent('title', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.subtitle']())}
          <input class="input input-xs w-full" value={p.subtitle ?? ''} oninput={(e) => patchContent('subtitle', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.bgColor']())}
          {@render colorRow(p.bg_color ?? '#1e293b', (v) => patchContent('bg_color', v))}</div>
        <div>{@render label(m['pageBuilder.textColor']())}
          {@render colorRow(p.text_color ?? '#ffffff', (v) => patchContent('text_color', v))}</div>
        <div>{@render label(m['pageBuilder.ctaText']())}
          <input class="input input-xs w-full" value={p.cta_text ?? ''} oninput={(e) => patchContent('cta_text', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.ctaUrl']())}
          <input class="input input-xs w-full font-mono" value={p.cta_url ?? ''} oninput={(e) => patchContent('cta_url', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.imageUrl']())}
          <input class="input input-xs w-full font-mono" value={p.image_url ?? ''} oninput={(e) => patchContent('image_url', e.currentTarget.value)} /></div>
        <div>{@render label(`Overlay opacity (${p.overlay_opacity ?? 40}%)`)}
          <input type="range" min="0" max="100" class="range range-xs range-primary w-full"
            value={p.overlay_opacity ?? 40}
            oninput={(e) => patchContent('overlay_opacity', Number(e.currentTarget.value))} /></div>

      {:else if block.type === 'icon'}
        <div>{@render label(m['pageBuilder.iconName']())}
          <div class="grid grid-cols-6 gap-1 max-h-40 overflow-y-auto rounded border border-base-300 p-1">
            {#each iconNames as name (name)}
              <button type="button" title={name}
                class="aspect-square rounded flex items-center justify-center text-[9px] font-mono
                  {p.name === name ? 'bg-primary text-primary-content' : 'hover:bg-base-200'}"
                onclick={() => patchContent('name', name)}
              >{name.slice(0, 3)}</button>
            {/each}
          </div>
        </div>
        <div>{@render label(m['pageBuilder.iconSize']())}
          <input type="number" min="12" max="160" class="input input-xs w-full" value={p.size ?? 32}
            oninput={(e) => patchContent('size', Number(e.currentTarget.value))} /></div>
        <div>{@render label(m['pageBuilder.color']())}
          {@render colorRow(p.color ?? '', (v) => patchContent('color', v))}</div>
        <div>{@render label(m['pageBuilder.iconLabel']())}
          <input class="input input-xs w-full" value={p.label ?? ''}
            oninput={(e) => patchContent('label', e.currentTarget.value)} /></div>

      {:else if block.type === 'button'}
        <div>{@render label(m['pageBuilder.buttonText']())}
          <input class="input input-xs w-full" value={p.label ?? ''}
            oninput={(e) => patchContent('label', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.buttonUrl']())}
          <input class="input input-xs w-full font-mono" value={p.href ?? ''}
            oninput={(e) => patchContent('href', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.variant']())}
          <select class="select select-xs w-full" value={p.variant ?? 'primary'}
            onchange={(e) => patchContent('variant', e.currentTarget.value)}>
            <option value="primary">{m['pageBuilder.primary']()}</option>
            <option value="dark">{m['pageBuilder.dark']()}</option>
            <option value="light">{m['pageBuilder.light']()}</option>
          </select></div>

      {:else if block.type === 'richtext'}
        <div>{@render label(m['pageBuilder.contentHtml']())}
          <textarea class="textarea textarea-xs w-full font-mono text-[10px] resize-y min-h-[120px]"
            value={p.content ?? ''}
            oninput={(e) => patchContent('content', e.currentTarget.value)}
          ></textarea></div>

      {:else if block.type === 'cta'}
        <div>{@render label(m['pageBuilder.heading']())}
          <input class="input input-xs w-full" value={p.heading ?? ''} oninput={(e) => patchContent('heading', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.subtext']())}
          <input class="input input-xs w-full" value={p.text ?? ''} oninput={(e) => patchContent('text', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.buttonText']())}
          <input class="input input-xs w-full" value={p.button_text ?? ''} oninput={(e) => patchContent('button_text', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.buttonUrl']())}
          <input class="input input-xs w-full font-mono" value={p.button_url ?? ''} oninput={(e) => patchContent('button_url', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.variant']())}
          <select class="select select-xs w-full" value={p.variant ?? 'primary'} onchange={(e) => patchContent('variant', e.currentTarget.value)}>
            <option value="primary">{m['pageBuilder.primary']()}</option>
            <option value="dark">{m['pageBuilder.dark']()}</option>
            <option value="light">{m['pageBuilder.light']()}</option>
          </select></div>

      {:else if block.type === 'stats'}
        <div>{@render label(m['pageBuilder.columns']())}
          <input type="number" min="1" max="6" class="input input-xs w-full" value={p.columns ?? 4}
            oninput={(e) => patchContent('columns', Number(e.currentTarget.value))} /></div>
        <div>
          <p class="text-[10px] font-medium text-base-content/65 mb-1">{m['pageBuilder.items']()}</p>
          <div class="space-y-1.5">
            {#each (p.items ?? []).map(asStat) as item, i}
              <div class="flex gap-1">
                <input class="input input-xs flex-1 min-w-0" placeholder="Value" value={item.value}
                  oninput={(e) => { const a=[...(p.items ?? [])]; a[i]={...asStat(a[i]),value:e.currentTarget.value}; patchItems(a); }} />
                <input class="input input-xs flex-1 min-w-0" placeholder="Label" value={item.label}
                  oninput={(e) => { const a=[...(p.items ?? [])]; a[i]={...asStat(a[i]),label:e.currentTarget.value}; patchItems(a); }} />
                <button class="btn btn-ghost btn-xs text-error px-1"
                  onclick={() => patchItems((p.items ?? []).filter((_, j) => j !== i))}>×</button>
              </div>
            {/each}
            <button class="btn btn-xs btn-ghost w-full border border-dashed border-base-300"
              onclick={() => patchItems([...(p.items ?? []),{value:'—',label:'Label'}])}>+ {m['pageBuilder.addItem']()}</button>
          </div>
        </div>

      {:else if block.type === 'columns'}
        <div>{@render label(m['pageBuilder.columns']())}
          <input type="number" min="1" max="4" class="input input-xs w-full" value={p.count ?? 2}
            oninput={(e) => patchContent('count', Number(e.currentTarget.value))} /></div>
        <div>
          <p class="text-[10px] font-medium text-base-content/65 mb-1">{m['pageBuilder.colContent']()}</p>
          {#each (p.items ?? []).map(asText) as col, i}
            <textarea class="textarea textarea-xs w-full font-mono text-[10px] resize-y min-h-[60px] mb-1"
              value={col}
              oninput={(e) => { const a=[...(p.items ?? [])]; a[i]=e.currentTarget.value; onPatch(b=>({...b,content:{...b.content,items:a}})); }}
            ></textarea>
          {/each}
        </div>

      {:else if block.type === 'spacer'}
        <div>{@render label(m['pageBuilder.heightPx']())}
          <input type="number" min="4" max="400" class="input input-xs w-full" value={p.height ?? 48}
            oninput={(e) => patchContent('height', Number(e.currentTarget.value))} /></div>

      {:else if block.type === 'divider'}
        <div>{@render label(m['pageBuilder.color']())}
          {@render colorRow(p.color ?? '#e5e7eb', (v) => patchContent('color', v))}</div>
        <div>{@render label(m['pageBuilder.thicknessPx']())}
          <input type="number" min="1" max="16" class="input input-xs w-full" value={p.thickness ?? 1}
            oninput={(e) => patchContent('thickness', Number(e.currentTarget.value))} /></div>
        <div>{@render label(m['pageBuilder.tabStyle']())}
          <select class="select select-xs w-full" value={p.line_style ?? 'solid'} onchange={(e) => patchContent('line_style', e.currentTarget.value)}>
            <option value="solid">{m['pageBuilder.solid']()}</option>
            <option value="dashed">{m['pageBuilder.dashed']()}</option>
            <option value="dotted">{m['pageBuilder.dotted']()}</option>
          </select></div>

      {:else if block.type === 'image'}
        <button class="btn btn-xs btn-outline w-full gap-1" onclick={() => openPicker('url')}>
          <ImageIcon size={11} /> {m['pageBuilder.browseMedia']()}
        </button>
        <div>{@render label(m['pageBuilder.imageUrl']())}
          <input class="input input-xs w-full font-mono" value={p.url ?? ''} oninput={(e) => patchContent('url', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.altText']())}
          <input class="input input-xs w-full" value={p.alt ?? ''} oninput={(e) => patchContent('alt', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.caption']())}
          <input class="input input-xs w-full" value={p.caption ?? ''} oninput={(e) => patchContent('caption', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.linkUrl']())}
          <input class="input input-xs w-full font-mono" value={p.link ?? ''} oninput={(e) => patchContent('link', e.currentTarget.value)} /></div>

      {:else if block.type === 'video'}
        <div>{@render label(m['pageBuilder.videoUrl']())}
          <input class="input input-xs w-full font-mono" placeholder="youtube.com/watch?v=…" value={p.url ?? ''}
            oninput={(e) => patchContent('url', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.caption']())}
          <input class="input input-xs w-full" value={p.caption ?? ''} oninput={(e) => patchContent('caption', e.currentTarget.value)} /></div>

      {:else if block.type === 'gallery'}
        <div>{@render label(m['pageBuilder.columns']())}
          <input type="number" min="1" max="6" class="input input-xs w-full" value={p.columns ?? 3}
            oninput={(e) => patchContent('columns', Number(e.currentTarget.value))} /></div>
        <div>
          <p class="text-[10px] font-medium text-base-content/65 mb-1">{m['pageBuilder.images']()}</p>
          <div class="space-y-1">
            {#each (p.images ?? []) as img, i}
              <div class="flex gap-1 items-center">
                <input class="input input-xs flex-1 min-w-0 font-mono text-[10px]" placeholder="URL" value={img.url ?? img}
                  oninput={(e) => { const a=[...(p.images??[])]; a[i]={url:e.currentTarget.value,alt:img.alt??''}; onPatch(b=>({...b,content:{...b.content,images:a}})); }} />
                <button class="btn btn-ghost btn-xs text-error px-1"
                  onclick={() => onPatch(b=>({...b,content:{...b.content,images:(p.images??[]).filter((_, j) => j !== i)}}))}>×</button>
              </div>
            {/each}
            <button class="btn btn-xs btn-ghost w-full border border-dashed border-base-300"
              onclick={() => onPatch(b=>({...b,content:{...b.content,images:[...(p.images??[]),{url:'',alt:''}]}}))}>+ {m['pageBuilder.addImage']()}</button>
          </div>
        </div>

      {:else if block.type === 'embed'}
        <div>{@render label(m['pageBuilder.htmlIframe']())}
          <textarea class="textarea textarea-xs w-full font-mono text-[10px] resize-y min-h-[120px]"
            value={p.html ?? ''}
            oninput={(e) => patchContent('html', e.currentTarget.value)}
          ></textarea></div>

      {:else if block.type === 'collection_list'}
        <div>{@render label(m['pageBuilder.collection']())}
          {#if collections.length > 0}
            <select class="select select-xs w-full font-mono" value={p.collection ?? ''} onchange={(e) => patchContent('collection', e.currentTarget.value)}>
              <option value="">— choose —</option>
              {#each collections as col (col)}<option value={col}>{col}</option>{/each}
            </select>
          {:else}
            <input class="input input-xs w-full font-mono" value={p.collection ?? ''} oninput={(e) => patchContent('collection', e.currentTarget.value)} />
          {/if}
        </div>

        <div>{@render label(m['pageBuilder.title']())}
          <input class="input input-xs w-full" value={p.title ?? ''} oninput={(e) => patchContent('title', e.currentTarget.value)} /></div>
        <div>{@render label(m['pageBuilder.layout']())}
          <select class="select select-xs w-full" value={p.view_type ?? 'list'} onchange={(e) => patchContent('view_type', e.currentTarget.value)}>
            {#each ['list', 'table', 'card', 'calendar', 'template'] as vt (vt)}<option value={vt}>{vt}</option>{/each}
          </select></div>
        {#if p.view_type === 'template'}
          <!--
            The item template. One block, designed once on the canvas, drawn once
            per record — the thing four fixed layouts could never be. Creating it
            here rather than on the canvas keeps the decision where the layout is
            chosen; editing it happens on the canvas like any other block.
          -->
          <div class="rounded border border-base-300 p-2 bg-base-200/40 space-y-1.5">
            {#if p.item_template}
              <p class="text-[10px] text-base-content/65 leading-snug">
                {m['pageBuilder.templateHint']()}
              </p>
              <button class="btn btn-xs btn-ghost w-full text-error"
                onclick={() => patchContent('item_template', null)}>{m['pageBuilder.templateRemove']()}</button>
            {:else}
              <p class="text-[10px] text-base-content/65 leading-snug">
                {m['pageBuilder.templateNew']()}
              </p>
              <button class="btn btn-xs btn-primary w-full"
                onclick={() => patchContent('item_template', {
                  id: crypto.randomUUID(),
                  type: 'container',
                  col_span: 6,
                  content: { gap: 'sm', children: [] },
                })}>{m['pageBuilder.templateCreate']()}</button>
            {/if}
          </div>

          {#if fieldNames.length > 0}
            <div>{@render label(m['pageBuilder.fieldsCopy']())}
              <div class="flex flex-wrap gap-1">
                {#each fieldNames as f (f)}
                  <button type="button" title={`${m['pageBuilder.copyField']()} {{${f}}}`}
                    class="text-[9px] font-mono rounded px-1 py-0.5 border transition-colors
                      {copied === f
                        ? 'bg-success/15 border-success text-success'
                        : 'bg-base-200 border-base-300 hover:border-primary'}"
                    onclick={() => copyField(f)}
                  >{copied === f ? m['pageBuilder.copied']() : f}</button>
                {/each}
              </div>
            </div>
          {/if}
        {/if}

        <div>{@render label(m['pageBuilder.fieldsList']())}
          <input class="input input-xs w-full font-mono" value={(p.fields??[]).join(', ')}
            oninput={(e) => patchContent('fields', e.currentTarget.value.split(',').map((s:string)=>s.trim()).filter(Boolean))} /></div>
        <div class="grid grid-cols-2 gap-1.5">
          <div>{@render label(m['pageBuilder.sortBy']())}
            <input class="input input-xs w-full font-mono" value={p.sort_field ?? ''} placeholder="created_at"
              oninput={(e) => patchContent('sort_field', e.currentTarget.value)} /></div>
          <div>{@render label(m['pageBuilder.lineStyle']())}
            <select class="select select-xs w-full" value={p.sort_dir ?? 'desc'} onchange={(e) => patchContent('sort_dir', e.currentTarget.value)}>
              <option value="desc">desc</option><option value="asc">asc</option>
            </select></div>
        </div>
        <div>{@render label(m['pageBuilder.rowLimit']())}
          <input type="number" min="1" max="100" class="input input-xs w-full" value={p.limit ?? 10}
            oninput={(e) => patchContent('limit', Number(e.currentTarget.value))} /></div>

        <!--
          Filters.
          The engine has compiled these since the beginning — `buildCondition`
          implements twelve operators and the resolver applies them — and there
          has never been a way to author one. A view migrated from portals kept
          the filters it was created with in the old Studio; a block created here
          could never have any. So the capability existed, unreachable, and the
          only rows a new data block could show were "the most recent N".
        -->
        <div class="pt-1">
          <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest mb-1">{m['pageBuilder.filters']()}</p>
          <div class="space-y-1.5">
            {#each (Array.isArray(p.filters) ? p.filters : []) as f, i (i)}
              <div class="rounded border border-base-300 p-1.5 space-y-1 bg-base-200/40">
                <div class="flex gap-1">
                  <input class="input input-xs flex-1 min-w-0 font-mono" placeholder="field"
                    value={f.field ?? ''}
                    oninput={(e) => patchFilter(i, { field: e.currentTarget.value })} />
                  <button class="btn btn-ghost btn-xs text-error px-1" title={m['pageBuilder.remove']()}
                    onclick={() => patchContent('filters', (p.filters ?? []).filter((_: unknown, j: number) => j !== i))}
                  >×</button>
                </div>
                <div class="flex gap-1">
                  <select class="select select-xs flex-1 min-w-0" value={f.op ?? 'eq'}
                    onchange={(e) => patchFilter(i, { op: e.currentTarget.value })}>
                    {#each FILTER_OPS as op (op.value)}<option value={op.value}>{op.label}</option>{/each}
                  </select>
                  {#if !UNARY_OPS.has(f.op)}
                    <input class="input input-xs flex-1 min-w-0" placeholder="value"
                      value={valueText(f)}
                      oninput={(e) => patchFilter(i, { value: parseValue(f.op, e.currentTarget.value) })} />
                  {/if}
                </div>
                {#if LIST_OPS.has(f.op)}
                  <p class="text-[9px] text-base-content/65">{m['pageBuilder.commaList']()}</p>
                {/if}
              </div>
            {/each}
            <button class="btn btn-xs btn-ghost w-full border border-dashed border-base-300"
              onclick={() => patchContent('filters', [...(p.filters ?? []), { field: '', op: 'eq', value: '' }])}
            >+ {m['pageBuilder.addFilter']()}</button>
          </div>
          {#if (p.filters ?? []).length > 0}
            <p class="text-[9px] text-base-content/65 mt-1 leading-snug">
              {m['pageBuilder.filtersAll']()}
            </p>
          {/if}
        </div>
      {/if}

    <!-- ── STYLE TAB ──────────────────────────────────────────────────── -->
    {:else}

      <div class="rounded bg-base-200 px-2 py-1.5 text-[10px] leading-snug">
        {m['pageBuilder.editingSize']()} <span class="font-semibold text-primary">{BREAKPOINT_LABEL[device]}</span>.
        {#if device === 'base'}{m['pageBuilder.appliesAll']()}
        {:else}{m['pageBuilder.overridesSmaller']()}{/if}
      </div>

      <!--
        Width in twelfths — `col_span`. Every zone page that migrated in was
        laid out entirely with this field, so it has to be editable and not
        merely preserved: a portal dashboard is an 8-and-4 pair, and losing the
        control would have quietly flattened every one of them to full width on
        the first edit.
      -->
      <div class="flex items-baseline justify-between">
        <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest">{m['pageBuilder.width']()}</p>
        <span class="text-[9px] text-primary font-mono">{BREAKPOINT_LABEL[device]}</span>
      </div>
      <div class="flex gap-1">
        {#each [3, 4, 6, 8, 12] as cs (cs)}
          <button
            class="btn btn-xs flex-1 px-0 {activeSpan === cs ? 'btn-primary' : 'btn-ghost border border-base-300'}"
            onclick={() => onPatch((b) => ({ ...b, [spanKey(device)]: cs }))}
          >{cs}</button>
        {/each}
      </div>
      {#if device !== 'base' && activeSpan === undefined}
        <p class="text-[9px] text-base-content/65 leading-snug">
          {m['pageBuilder.inheritsSmaller']()}
        </p>
      {:else if device !== 'base'}
        <button class="btn btn-ghost btn-xs w-full text-[10px]"
          onclick={() => onPatch((b) => { const n = { ...b }; delete n[spanKey(device)]; return n; })}
        >{m['pageBuilder.clearOverride']()}</button>
      {/if}

      <!--
        Motion. A short list on purpose: "fade this in when it appears" and
        "keep this at the top" are the two a portal or a public-sector page
        actually uses. A visitor who asked for reduced motion gets none of it,
        decided in the stylesheet so it responds without a reload.
      -->
      <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest">{m['pageBuilder.motion']()}</p>
      <div>{@render label(m['pageBuilder.motionType']())}
        <select class="select select-xs w-full" value={block.motion?.type ?? 'none'}
          onchange={(e) => patchMotion('type', e.currentTarget.value)}>
          {#each motionTypes as t (t)}<option value={t}>{t}</option>{/each}
        </select></div>
      {#if (block.motion?.type ?? 'none') !== 'none'}
        <div class="grid grid-cols-2 gap-1.5">
          <div>{@render label(m['pageBuilder.motionDuration']())}
            <input type="number" min="100" max="3000" step="50" class="input input-xs w-full"
              value={block.motion?.duration ?? 500}
              oninput={(e) => patchMotion('duration', Number(e.currentTarget.value))} /></div>
          <div>{@render label(m['pageBuilder.motionDelay']())}
            <input type="number" min="0" max="2000" step="50" class="input input-xs w-full"
              value={block.motion?.delay ?? 0}
              oninput={(e) => patchMotion('delay', Number(e.currentTarget.value))} /></div>
        </div>
      {/if}
      <label class="label cursor-pointer justify-start gap-2 py-0">
        <input type="checkbox" class="checkbox checkbox-xs" checked={block.motion?.sticky === true}
          onchange={(e) => patchMotion('sticky', e.currentTarget.checked)} />
        <span class="label-text text-[10px]">{m['pageBuilder.motionSticky']()}</span>
      </label>
      {#if block.motion?.sticky}
        <div>{@render label(m['pageBuilder.motionOffset']())}
          <input type="number" min="0" max="400" class="input input-xs w-full"
            value={block.motion?.stickyOffset ?? 0}
            oninput={(e) => patchMotion('stickyOffset', Number(e.currentTarget.value))} /></div>
      {/if}

      <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest">{m['pageBuilder.padding']()}</p>
      <div class="grid grid-cols-2 gap-1.5">
        {#each [['Top','paddingTop'],['Bottom','paddingBottom'],['Left','paddingLeft'],['Right','paddingRight']] as [lbl, key]}
          <div>
            <label class="text-[9px] text-base-content/65" for={`sp-${key}`}>{lbl}</label>
            <input id={`sp-${key}`} type="number" min="0" class="input input-xs w-full"
              value={s[key as keyof BlockStyle] ?? ''}
              oninput={(e) => patchStyle(key as keyof BlockStyle, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
          </div>
        {/each}
      </div>

      <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest mt-2">{m['pageBuilder.margin']()}</p>
      <div class="grid grid-cols-2 gap-1.5">
        {#each [['Top','marginTop'],['Bottom','marginBottom']] as [lbl, key]}
          <div>
            <label class="text-[9px] text-base-content/65" for={`off-${key}`}>{lbl}</label>
            <input id={`off-${key}`} type="number" class="input input-xs w-full"
              value={s[key as keyof BlockStyle] ?? ''}
              oninput={(e) => patchStyle(key as keyof BlockStyle, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
          </div>
        {/each}
      </div>

      <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest mt-2">{m['pageBuilder.colors']()}</p>
      <div>{@render label(m['pageBuilder.background']())}
        <div class="flex gap-1 items-center">
          <input type="color" class="h-6 w-8 rounded cursor-pointer border border-base-300 p-0.5 shrink-0"
            value={s.backgroundColor || '#ffffff'}
            oninput={(e) => patchStyle('backgroundColor', e.currentTarget.value)} />
          <input class="input input-xs flex-1 font-mono" value={s.backgroundColor ?? ''}
            oninput={(e) => patchStyle('backgroundColor', e.currentTarget.value || undefined)} />
          {#if s.backgroundColor}
            <button class="btn btn-ghost btn-xs px-1 text-base-content/65"
              onclick={() => patchStyle('backgroundColor', undefined)}>×</button>
          {/if}
        </div>
      </div>
      <div>{@render label(m['pageBuilder.textColor']())}
        <div class="flex gap-1 items-center">
          <input type="color" class="h-6 w-8 rounded cursor-pointer border border-base-300 p-0.5 shrink-0"
            value={s.textColor || '#000000'}
            oninput={(e) => patchStyle('textColor', e.currentTarget.value)} />
          <input class="input input-xs flex-1 font-mono" value={s.textColor ?? ''}
            oninput={(e) => patchStyle('textColor', e.currentTarget.value || undefined)} />
          {#if s.textColor}
            <button class="btn btn-ghost btn-xs px-1 text-base-content/65"
              onclick={() => patchStyle('textColor', undefined)}>×</button>
          {/if}
        </div>
      </div>

      <p class="text-[10px] font-bold text-base-content/65 uppercase tracking-widest mt-2">{m['pageBuilder.typography']()}</p>
      <div>{@render label(m['pageBuilder.textAlign']())}
        <div class="flex gap-1">
          {#each ['left','center','right'] as align}
            <button
              class="btn btn-xs flex-1 {s.textAlign === align ? 'btn-primary' : 'btn-ghost border border-base-300'}"
              onclick={() => patchStyle('textAlign', s.textAlign === align ? undefined : align as BlockStyle['textAlign'])}
            >{align[0].toUpperCase()}</button>
          {/each}
        </div>
      </div>
      <div>{@render label(m['pageBuilder.radiusPx']())}
        <input type="number" min="0" max="64" class="input input-xs w-full"
          value={s.borderRadius ?? ''}
          oninput={(e) => patchStyle('borderRadius', e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
      </div>

    {/if}
  </div>
</div>

{#if picker.open}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-sm">{m['pageBuilder.chooseImage']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (picker = { open: false, target: null })}>
          <XIcon size={14} />
        </button>
      </div>

      {#if mediaState === 'loading'}
        <p class="text-sm text-base-content/65 py-8 text-center">{m['pageBuilder.loading']()}</p>
      {:else if mediaState === 'unavailable'}
        <p class="text-sm text-base-content/65 py-8 text-center">
          {m['pageBuilder.mediaOff']()}
        </p>
      {:else if mediaFiles.length === 0}
        <p class="text-sm text-base-content/65 py-8 text-center">{m['pageBuilder.noImages']()}</p>
      {:else}
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 max-h-[26rem] overflow-y-auto">
          {#each mediaFiles as f (f.id)}
            <button class="rounded-lg border border-base-300 hover:border-primary overflow-hidden
              aspect-square bg-base-200" title={f.original_name} onclick={() => chooseMedia(f)}>
              <img src={mediaUrl(f)} alt={f.original_name} class="w-full h-full object-cover" />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
