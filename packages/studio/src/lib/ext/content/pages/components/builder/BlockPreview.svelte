<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import type { Block, BlockStyle } from '../../lib/builder-types.js';
  import { safeHtml } from '../../lib/sanitize.js';

  let { block }: { block: Block } = $props();

  function styleStr(s: BlockStyle = {}): string {
    const parts: string[] = [];
    if (s.paddingTop    != null) parts.push(`padding-top:${s.paddingTop}px`);
    if (s.paddingBottom != null) parts.push(`padding-bottom:${s.paddingBottom}px`);
    if (s.paddingLeft   != null) parts.push(`padding-left:${s.paddingLeft}px`);
    if (s.paddingRight  != null) parts.push(`padding-right:${s.paddingRight}px`);
    if (s.marginTop     != null) parts.push(`margin-top:${s.marginTop}px`);
    if (s.marginBottom  != null) parts.push(`margin-bottom:${s.marginBottom}px`);
    if (s.backgroundColor)      parts.push(`background-color:${s.backgroundColor}`);
    if (s.textColor)             parts.push(`color:${s.textColor}`);
    if (s.borderRadius  != null) parts.push(`border-radius:${s.borderRadius}px`);
    if (s.textAlign)             parts.push(`text-align:${s.textAlign}`);
    return parts.join(';');
  }

  const p = $derived(block.content);
  const outer = $derived(styleStr(block.style));
</script>

<div style={outer} class="w-full overflow-hidden">

  {#if block.type === 'hero'}
    <div
      class="relative flex flex-col items-center justify-center px-8 py-16 text-center min-h-[180px]"
      style="background-color:{p.bg_color ?? '#1e293b'}; color:{p.text_color ?? '#fff'}"
    >
      {#if p.image_url}
        <img src={p.image_url} alt="" class="absolute inset-0 w-full h-full object-cover pointer-events-none select-none" />
        <div class="absolute inset-0" style="background:rgba(0,0,0,{(p.overlay_opacity ?? 40)/100})"></div>
      {/if}
      <div class="relative z-10 space-y-2">
        <h1 class="text-3xl font-bold leading-tight">{p.title ?? 'Hero Title'}</h1>
        {#if p.subtitle}<p class="text-base opacity-80">{p.subtitle}</p>{/if}
        {#if p.cta_text}
          <span class="inline-block mt-3 px-5 py-2 rounded-lg text-sm font-semibold bg-white/20 border border-white/30">{p.cta_text}</span>
        {/if}
      </div>
    </div>

  {:else if block.type === 'richtext'}
    <div class="prose prose-sm max-w-none px-4 py-3">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html p.content ?? `<p>${m['content.pages.b.richTextPh']()}</p>`}
    </div>

  {:else if block.type === 'cta'}
    {@const variant = p.variant ?? 'primary'}
    <div class="flex flex-col sm:flex-row items-center justify-between gap-4 px-6 py-8 rounded-xl
      {variant === 'primary' ? 'bg-primary text-primary-content' :
       variant === 'dark'    ? 'bg-neutral text-neutral-content' : 'bg-base-200'}">
      <div>
        <p class="font-bold text-lg leading-tight">{p.heading ?? 'Ready to get started?'}</p>
        {#if p.text}<p class="text-sm opacity-80 mt-0.5">{p.text}</p>{/if}
      </div>
      {#if p.button_text}
        <span class="btn btn-sm shrink-0 {variant === 'primary' ? 'btn-neutral' : 'btn-primary'}">{p.button_text}</span>
      {/if}
    </div>

  {:else if block.type === 'stats'}
    {@const cols = p.columns ?? 4}
    <div class="grid gap-4 py-6 px-4" style="grid-template-columns:repeat({cols},1fr)">
      {#each (p.items ?? []) as item}
        <div class="text-center">
          <p class="text-3xl font-extrabold text-primary leading-none">{item.value}</p>
          <p class="text-xs text-base-content/60 mt-1">{item.label}</p>
        </div>
      {/each}
    </div>

  {:else if block.type === 'columns'}
    {@const count = p.count ?? 2}
    <div class="grid gap-3 p-3" style="grid-template-columns:repeat({count},1fr)">
      {#each (p.items ?? []) as col}
        <div class="min-h-[60px] bg-base-200 rounded-lg p-3 text-sm prose prose-sm max-w-none">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html col}
        </div>
      {/each}
    </div>

  {:else if block.type === 'spacer'}
    <div style="height:{p.height ?? 48}px" class="w-full flex items-center justify-center">
      <span class="text-[10px] text-base-content/20 font-mono">{p.height ?? 48}px</span>
    </div>

  {:else if block.type === 'divider'}
    <div class="px-4 py-3">
      <hr style="border-color:{p.color ?? '#e5e7eb'};border-top-width:{p.thickness ?? 1}px;border-style:{p.line_style ?? 'solid'}" />
    </div>

  {:else if block.type === 'image'}
    <figure class="w-full">
      {#if p.url}
        <img src={p.url} alt={p.alt ?? ''} class="w-full object-cover rounded" />
      {:else}
        <div class="flex items-center justify-center bg-base-200 rounded h-32 text-base-content/30 text-sm gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          Image
        </div>
      {/if}
      {#if p.caption}<figcaption class="text-center text-xs text-base-content/50 mt-1">{p.caption}</figcaption>{/if}
    </figure>

  {:else if block.type === 'video'}
    <div class="w-full aspect-video bg-base-300 rounded flex items-center justify-center">
      {#if p.url}
        {@const embedUrl = p.url.includes('youtu') ? p.url.replace('watch?v=', 'embed/').replace('youtu.be/', 'youtube.com/embed/') : p.url}
        <iframe src={embedUrl} title={p.caption ?? 'video'} class="w-full h-full rounded" allowfullscreen></iframe>
      {:else}
        <div class="flex flex-col items-center gap-2 text-base-content/30">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/>
          </svg>
          <span class="text-xs">{m['content.pages.b.videoLabel']()}</span>
        </div>
      {/if}
    </div>

  {:else if block.type === 'gallery'}
    {@const cols = p.columns ?? 3}
    <div class="grid gap-1.5 p-1" style="grid-template-columns:repeat({cols},1fr)">
      {#each (p.images ?? []) as img}
        <img src={img.url ?? img} alt={img.alt ?? ''} class="w-full aspect-square object-cover rounded" />
      {:else}
        {#each { length: cols } as _, i (i)}
          <div class="aspect-square bg-base-200 rounded flex items-center justify-center text-base-content/20 text-xs">
            {i + 1}
          </div>
        {/each}
      {/each}
    </div>

  {:else if block.type === 'embed'}
    {#if p.html}
      <div class="p-3">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html p.html}
      </div>
    {:else}
      <div class="flex items-center justify-center h-16 bg-base-200 rounded text-base-content/30 text-xs gap-1.5 font-mono">
        <span>&lt;/&gt;</span> HTML / Embed
      </div>
    {/if}

  {:else if block.type === 'button'}
    <!--
      A neutral button, not the variant's real classes. Those live in the public
      renderer, and copying the map here would make a second one to keep in
      step — which is the defect this whole file was part of. The canvas shows
      that a button is here and what it says; how it is skinned is the renderer's
      answer.
    -->
    <div class="p-3">
      <span class="btn btn-primary btn-sm pointer-events-none">
        {p.label ?? p.text ?? 'Button'}
      </span>
      {#if p.variant}<span class="ml-2 text-[10px] font-mono opacity-40">{p.variant}</span>{/if}
    </div>

  {:else if block.type === 'icon'}
    <!--
      The name and size, not the glyph. The icon paths are `client/icons.ts`,
      which ships with the RENDERER and is not synced into the Studio — the
      editor only ever receives the names, from `GET /pages/vocabulary`. Drawing
      the real glyph here would mean a second copy of the icon set.
    -->
    <div class="p-3 flex items-center gap-2 text-base-content/60">
      <span class="inline-flex items-center justify-center rounded border border-dashed"
        style="width:{Math.min(Number(p.size) || 32, 48)}px;height:{Math.min(Number(p.size) || 32, 48)}px;color:{p.color || 'currentColor'}">
        <span class="text-[9px] font-mono">icon</span>
      </span>
      <span class="text-xs font-mono">{p.name ?? 'star'}</span>
      {#if p.label}<span class="text-sm">{p.label}</span>{/if}
    </div>

  <!--
    Legacy types. The builder cannot add these, but stored pages contain them —
    they came from the textarea editor this builder replaced — and the public
    renderer draws them. The canvas showed a grey box with the type name instead,
    so an author editing an older page saw a placeholder where a visitor saw
    content, with no way to tell that apart from a block that was broken.
  -->
  {:else if block.type === 'heading'}
    <div class="p-3"><span class="text-xl font-bold">{p.text ?? p.content ?? 'Heading'}</span></div>

  {:else if block.type === 'text'}
    <div class="p-3 text-sm opacity-80">{p.text ?? p.content ?? ''}</div>

  {:else if block.type === 'html'}
    <div class="p-3">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html safeHtml(String(p.html ?? p.content ?? ''))}
    </div>

  {:else if block.type === 'container'}
    <!-- Reached only if a container is previewed outside the canvas; the canvas
         draws containers as their real contents instead. -->
    <div class="p-4 text-xs text-base-content/40 border border-dashed rounded">
      Container — {(block.content?.children ?? []).length} block(s)
    </div>

  {:else if block.type === 'collection_list'}
    <div class="p-3">
      <div class="flex items-center justify-between mb-2">
        {#if p.title}<p class="text-sm font-semibold">{p.title}</p>{/if}
        {#if p.collection}<span class="text-[10px] badge badge-ghost font-mono">{p.collection}</span>{/if}
      </div>
      <div class="overflow-hidden rounded border border-base-300">
        <table class="table table-xs w-full">
          <thead>
            <tr class="bg-base-200">
              {#if p.fields?.length > 0}
                {#each p.fields as f}<th class="font-mono text-[10px]">{f}</th>{/each}
              {:else}
                <th class="text-base-content/30 text-[10px] italic">{m['content.pages.b.configFields']()}</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each { length: 3 } as _, r (r)}
              <tr>
                {#if p.fields?.length > 0}
                  {#each p.fields as _, c (c)}
                    <td><div class="h-2.5 rounded bg-base-200 w-{c % 2 === 0 ? 20 : 16}"></div></td>
                  {/each}
                {:else}
                  <td><div class="h-2.5 rounded bg-base-200 w-24"></div></td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if p.limit}<p class="text-[10px] text-base-content/30 mt-1">Showing up to {p.limit} records</p>{/if}
    </div>

  {:else}
    <div class="flex items-center justify-center h-12 bg-base-200 rounded text-base-content/30 text-xs font-mono">
      {block.type}
    </div>
  {/if}

</div>
