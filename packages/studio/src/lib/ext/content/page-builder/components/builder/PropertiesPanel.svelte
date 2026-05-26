<script lang="ts">
import { onMount } from 'svelte';
import type { Block, BlockStyle } from '../../lib/builder-types.js';

let {
  block,
  onPatch,
}: {
  block: Block;
  onPatch: (fn: (b: Block) => Block) => void;
} = $props();

let tab = $state<'content' | 'style'>('content');
let collections = $state<string[]>([]);

onMount(async () => {
  try {
    const res = await fetch('/api/collections');
    const json = await res.json();
    collections = (json.collections ?? []).map((c: any) => c.name);
  } catch {
    /* studio may not be wired yet */
  }
});

function patchProp(key: string, value: any) {
  onPatch((b) => ({ ...b, props: { ...b.props, [key]: value } }));
}

function patchStyle(key: keyof BlockStyle, value: any) {
  const v = value === '' ? undefined : value;
  onPatch((b) => ({ ...b, style: { ...(b.style ?? {}), [key]: v } }));
}

function patchItems(items: any[]) {
  onPatch((b) => ({ ...b, props: { ...b.props, items } }));
}

const p = $derived(block.props);
const s = $derived(block.style ?? ({} as BlockStyle));
</script>

{#snippet label(text: string)}
  <label class="block text-[10px] text-base-content/50 mb-0.5">{text}</label>
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
    <span class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest">Properties</span>
    <span class="text-[10px] badge badge-ghost font-mono">{block.type}</span>
  </div>

  <!-- Tabs -->
  <div class="flex border-b border-base-300">
    <button
      class="flex-1 py-2 text-xs font-medium transition-colors
        {tab === 'content' ? 'text-primary border-b-2 border-primary' : 'text-base-content/50 hover:text-base-content'}"
      onclick={() => (tab = 'content')}
    >Content</button>
    <button
      class="flex-1 py-2 text-xs font-medium transition-colors
        {tab === 'style' ? 'text-primary border-b-2 border-primary' : 'text-base-content/50 hover:text-base-content'}"
      onclick={() => (tab = 'style')}
    >Style</button>
  </div>

  <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3">

    <!-- ── CONTENT TAB ───────────────────────────────────────────────── -->
    {#if tab === 'content'}

      {#if block.type === 'hero'}
        <div>{@render label('Title')}
          <input class="input input-xs w-full" value={p.title ?? ''} oninput={(e) => patchProp('title', e.currentTarget.value)} /></div>
        <div>{@render label('Subtitle')}
          <input class="input input-xs w-full" value={p.subtitle ?? ''} oninput={(e) => patchProp('subtitle', e.currentTarget.value)} /></div>
        <div>{@render label('Background color')}
          {@render colorRow(p.bg_color ?? '#1e293b', (v) => patchProp('bg_color', v))}</div>
        <div>{@render label('Text color')}
          {@render colorRow(p.text_color ?? '#ffffff', (v) => patchProp('text_color', v))}</div>
        <div>{@render label('CTA text')}
          <input class="input input-xs w-full" value={p.cta_text ?? ''} oninput={(e) => patchProp('cta_text', e.currentTarget.value)} /></div>
        <div>{@render label('CTA URL')}
          <input class="input input-xs w-full font-mono" value={p.cta_url ?? ''} oninput={(e) => patchProp('cta_url', e.currentTarget.value)} /></div>
        <div>{@render label('Image URL')}
          <input class="input input-xs w-full font-mono" value={p.image_url ?? ''} oninput={(e) => patchProp('image_url', e.currentTarget.value)} /></div>
        <div>{@render label(`Overlay opacity (${p.overlay_opacity ?? 40}%)`)}
          <input type="range" min="0" max="100" class="range range-xs range-primary w-full"
            value={p.overlay_opacity ?? 40}
            oninput={(e) => patchProp('overlay_opacity', Number(e.currentTarget.value))} /></div>

      {:else if block.type === 'richtext'}
        <div>{@render label('Content (HTML)')}
          <textarea class="textarea textarea-xs w-full font-mono text-[10px] resize-y min-h-[120px]"
            value={p.content ?? ''}
            oninput={(e) => patchProp('content', e.currentTarget.value)}
          ></textarea></div>

      {:else if block.type === 'cta'}
        <div>{@render label('Heading')}
          <input class="input input-xs w-full" value={p.heading ?? ''} oninput={(e) => patchProp('heading', e.currentTarget.value)} /></div>
        <div>{@render label('Subtext')}
          <input class="input input-xs w-full" value={p.text ?? ''} oninput={(e) => patchProp('text', e.currentTarget.value)} /></div>
        <div>{@render label('Button text')}
          <input class="input input-xs w-full" value={p.button_text ?? ''} oninput={(e) => patchProp('button_text', e.currentTarget.value)} /></div>
        <div>{@render label('Button URL')}
          <input class="input input-xs w-full font-mono" value={p.button_url ?? ''} oninput={(e) => patchProp('button_url', e.currentTarget.value)} /></div>
        <div>{@render label('Variant')}
          <select class="select select-xs w-full" value={p.variant ?? 'primary'} onchange={(e) => patchProp('variant', e.currentTarget.value)}>
            <option value="primary">Primary</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select></div>

      {:else if block.type === 'stats'}
        <div>{@render label('Columns')}
          <input type="number" min="1" max="6" class="input input-xs w-full" value={p.columns ?? 4}
            oninput={(e) => patchProp('columns', Number(e.currentTarget.value))} /></div>
        <div>
          <p class="text-[10px] font-medium text-base-content/60 mb-1">Items</p>
          <div class="space-y-1.5">
            {#each (p.items ?? []) as item, i}
              <div class="flex gap-1">
                <input class="input input-xs flex-1 min-w-0" placeholder="Value" value={item.value}
                  oninput={(e) => { const a=[...(p.items??[])]; a[i]={...a[i],value:e.currentTarget.value}; patchItems(a); }} />
                <input class="input input-xs flex-1 min-w-0" placeholder="Label" value={item.label}
                  oninput={(e) => { const a=[...(p.items??[])]; a[i]={...a[i],label:e.currentTarget.value}; patchItems(a); }} />
                <button class="btn btn-ghost btn-xs text-error px-1"
                  onclick={() => patchItems((p.items??[]).filter((_:any,j:number)=>j!==i))}>×</button>
              </div>
            {/each}
            <button class="btn btn-xs btn-ghost w-full border border-dashed border-base-300"
              onclick={() => patchItems([...(p.items??[]),{value:'—',label:'Label'}])}>+ Add item</button>
          </div>
        </div>

      {:else if block.type === 'columns'}
        <div>{@render label('Columns')}
          <input type="number" min="1" max="4" class="input input-xs w-full" value={p.count ?? 2}
            oninput={(e) => patchProp('count', Number(e.currentTarget.value))} /></div>
        <div>
          <p class="text-[10px] font-medium text-base-content/60 mb-1">Column content (HTML)</p>
          {#each (p.items ?? []) as col, i}
            <textarea class="textarea textarea-xs w-full font-mono text-[10px] resize-y min-h-[60px] mb-1"
              value={col}
              oninput={(e) => { const a=[...(p.items??[])]; a[i]=e.currentTarget.value; onPatch(b=>({...b,props:{...b.props,items:a}})); }}
            ></textarea>
          {/each}
        </div>

      {:else if block.type === 'spacer'}
        <div>{@render label('Height (px)')}
          <input type="number" min="4" max="400" class="input input-xs w-full" value={p.height ?? 48}
            oninput={(e) => patchProp('height', Number(e.currentTarget.value))} /></div>

      {:else if block.type === 'divider'}
        <div>{@render label('Color')}
          {@render colorRow(p.color ?? '#e5e7eb', (v) => patchProp('color', v))}</div>
        <div>{@render label('Thickness (px)')}
          <input type="number" min="1" max="16" class="input input-xs w-full" value={p.thickness ?? 1}
            oninput={(e) => patchProp('thickness', Number(e.currentTarget.value))} /></div>
        <div>{@render label('Style')}
          <select class="select select-xs w-full" value={p.line_style ?? 'solid'} onchange={(e) => patchProp('line_style', e.currentTarget.value)}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
          </select></div>

      {:else if block.type === 'image'}
        <div>{@render label('Image URL')}
          <input class="input input-xs w-full font-mono" value={p.url ?? ''} oninput={(e) => patchProp('url', e.currentTarget.value)} /></div>
        <div>{@render label('Alt text')}
          <input class="input input-xs w-full" value={p.alt ?? ''} oninput={(e) => patchProp('alt', e.currentTarget.value)} /></div>
        <div>{@render label('Caption')}
          <input class="input input-xs w-full" value={p.caption ?? ''} oninput={(e) => patchProp('caption', e.currentTarget.value)} /></div>
        <div>{@render label('Link URL')}
          <input class="input input-xs w-full font-mono" value={p.link ?? ''} oninput={(e) => patchProp('link', e.currentTarget.value)} /></div>

      {:else if block.type === 'video'}
        <div>{@render label('Video URL')}
          <input class="input input-xs w-full font-mono" placeholder="youtube.com/watch?v=…" value={p.url ?? ''}
            oninput={(e) => patchProp('url', e.currentTarget.value)} /></div>
        <div>{@render label('Caption')}
          <input class="input input-xs w-full" value={p.caption ?? ''} oninput={(e) => patchProp('caption', e.currentTarget.value)} /></div>

      {:else if block.type === 'gallery'}
        <div>{@render label('Columns')}
          <input type="number" min="1" max="6" class="input input-xs w-full" value={p.columns ?? 3}
            oninput={(e) => patchProp('columns', Number(e.currentTarget.value))} /></div>
        <div>
          <p class="text-[10px] font-medium text-base-content/60 mb-1">Images</p>
          <div class="space-y-1">
            {#each (p.images ?? []) as img, i}
              <div class="flex gap-1 items-center">
                <input class="input input-xs flex-1 min-w-0 font-mono text-[10px]" placeholder="URL" value={img.url ?? img}
                  oninput={(e) => { const a=[...(p.images??[])]; a[i]={url:e.currentTarget.value,alt:img.alt??''}; onPatch(b=>({...b,props:{...b.props,images:a}})); }} />
                <button class="btn btn-ghost btn-xs text-error px-1"
                  onclick={() => onPatch(b=>({...b,props:{...b.props,images:(p.images??[]).filter((_:any,j:number)=>j!==i)}}))}>×</button>
              </div>
            {/each}
            <button class="btn btn-xs btn-ghost w-full border border-dashed border-base-300"
              onclick={() => onPatch(b=>({...b,props:{...b.props,images:[...(p.images??[]),{url:'',alt:''}]}}))}>+ Add image</button>
          </div>
        </div>

      {:else if block.type === 'embed'}
        <div>{@render label('HTML / iframe')}
          <textarea class="textarea textarea-xs w-full font-mono text-[10px] resize-y min-h-[120px]"
            value={p.html ?? ''}
            oninput={(e) => patchProp('html', e.currentTarget.value)}
          ></textarea></div>

      {:else if block.type === 'data_table'}
        <div>{@render label('Collection')}
          {#if collections.length > 0}
            <select class="select select-xs w-full font-mono" value={p.collection ?? ''} onchange={(e) => patchProp('collection', e.currentTarget.value)}>
              <option value="">— choose —</option>
              {#each collections as col}<option value={col}>{col}</option>{/each}
            </select>
          {:else}
            <input class="input input-xs w-full font-mono" value={p.collection ?? ''} oninput={(e) => patchProp('collection', e.currentTarget.value)} />
          {/if}
        </div>
        <div>{@render label('Title')}
          <input class="input input-xs w-full" value={p.title ?? ''} oninput={(e) => patchProp('title', e.currentTarget.value)} /></div>
        <div>{@render label('Fields (comma-separated)')}
          <input class="input input-xs w-full font-mono" value={(p.fields??[]).join(', ')}
            oninput={(e) => patchProp('fields', e.currentTarget.value.split(',').map((s:string)=>s.trim()).filter(Boolean))} /></div>
        <div>{@render label('Row limit')}
          <input type="number" min="1" max="200" class="input input-xs w-full" value={p.limit ?? 10}
            oninput={(e) => patchProp('limit', Number(e.currentTarget.value))} /></div>
      {/if}

    <!-- ── STYLE TAB ──────────────────────────────────────────────────── -->
    {:else}

      <p class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest">Padding</p>
      <div class="grid grid-cols-2 gap-1.5">
        {#each [['Top','paddingTop'],['Bottom','paddingBottom'],['Left','paddingLeft'],['Right','paddingRight']] as [lbl, key]}
          <div>
            <label class="text-[9px] text-base-content/40">{lbl}</label>
            <input type="number" min="0" class="input input-xs w-full"
              value={s[key as keyof BlockStyle] ?? ''}
              oninput={(e) => patchStyle(key as keyof BlockStyle, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
          </div>
        {/each}
      </div>

      <p class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest mt-2">Margin</p>
      <div class="grid grid-cols-2 gap-1.5">
        {#each [['Top','marginTop'],['Bottom','marginBottom']] as [lbl, key]}
          <div>
            <label class="text-[9px] text-base-content/40">{lbl}</label>
            <input type="number" class="input input-xs w-full"
              value={s[key as keyof BlockStyle] ?? ''}
              oninput={(e) => patchStyle(key as keyof BlockStyle, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
          </div>
        {/each}
      </div>

      <p class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest mt-2">Colors</p>
      <div>{@render label('Background')}
        <div class="flex gap-1 items-center">
          <input type="color" class="h-6 w-8 rounded cursor-pointer border border-base-300 p-0.5 shrink-0"
            value={s.backgroundColor || '#ffffff'}
            oninput={(e) => patchStyle('backgroundColor', e.currentTarget.value)} />
          <input class="input input-xs flex-1 font-mono" value={s.backgroundColor ?? ''}
            oninput={(e) => patchStyle('backgroundColor', e.currentTarget.value || undefined)} />
          {#if s.backgroundColor}
            <button class="btn btn-ghost btn-xs px-1 text-base-content/40"
              onclick={() => patchStyle('backgroundColor', undefined)}>×</button>
          {/if}
        </div>
      </div>
      <div>{@render label('Text color')}
        <div class="flex gap-1 items-center">
          <input type="color" class="h-6 w-8 rounded cursor-pointer border border-base-300 p-0.5 shrink-0"
            value={s.textColor || '#000000'}
            oninput={(e) => patchStyle('textColor', e.currentTarget.value)} />
          <input class="input input-xs flex-1 font-mono" value={s.textColor ?? ''}
            oninput={(e) => patchStyle('textColor', e.currentTarget.value || undefined)} />
          {#if s.textColor}
            <button class="btn btn-ghost btn-xs px-1 text-base-content/40"
              onclick={() => patchStyle('textColor', undefined)}>×</button>
          {/if}
        </div>
      </div>

      <p class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest mt-2">Typography</p>
      <div>{@render label('Text align')}
        <div class="flex gap-1">
          {#each ['left','center','right'] as align}
            <button
              class="btn btn-xs flex-1 {s.textAlign === align ? 'btn-primary' : 'btn-ghost border border-base-300'}"
              onclick={() => patchStyle('textAlign', s.textAlign === align ? undefined : align as any)}
            >{align[0].toUpperCase()}</button>
          {/each}
        </div>
      </div>
      <div>{@render label('Border radius (px)')}
        <input type="number" min="0" max="64" class="input input-xs w-full"
          value={s.borderRadius ?? ''}
          oninput={(e) => patchStyle('borderRadius', e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
      </div>

    {/if}
  </div>
</div>
