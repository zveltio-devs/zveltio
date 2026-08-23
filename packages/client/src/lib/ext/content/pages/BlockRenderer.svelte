<script lang="ts">
  /**
   * The canonical renderer for a page's blocks.
   *
   * FOUR block vocabularies existed here and none of them agreed:
   *
   *   1. the visual builder's library — hero, richtext, image, columns, cta,
   *      stats, embed, spacer, video, gallery, divider, collection_list
   *   2. the textarea editor it replaced — heading, text, image, button,
   *      divider, html
   *   3. `zv_page_block_types`, seeded with a third list
   *   4. the reference host's renderer, written against (2)
   *
   * The builder was deleted by accident in May and the renderer stayed aligned
   * to the editor that deletion resurrected. Measured before writing this: a
   * page built from the twelve library blocks rendered as TEN "Unsupported
   * block" placeholders, one `<hr>`, and no image — because the builder writes
   * `content.url` and the renderer read `content.src`.
   *
   * So this is the union, and legacy names are first-class rather than
   * migrated: real installs have pages authored with `heading`/`text`/`button`
   * from the textarea editor, and rewriting stored rows to rename a block is a
   * data migration nobody needs when an alias costs one line.
   *
   * Unknown types still degrade to a visible placeholder — the contract's
   * forward-compat rule, and the thing that made the drift visible at all.
   *
   * Everything reaching {@html} goes through `safeHtml` (DOMPurify) here, on
   * top of the server-side scrub in engine/sanitize.ts. Two layers, because
   * this is the payload a visitor's browser executes.
   */
  import { safeHtml } from './sanitize.js';
  import CollectionList from './CollectionList.svelte';
  import { bindBlock } from './bind.js';
  import { spanClasses, styleVars } from './responsive.js';
  import { ICONS } from './icons.js';
  import { motionAttrs } from './motion.js';
  // A container draws its children with this same component. Svelte allows the
  // self-import; the recursion terminates because only `container` recurses and
  // the editor refuses to nest a container inside itself.
  import Self from './BlockRenderer.svelte';

  import { onMount } from 'svelte';

  // biome-ignore lint/suspicious/noExplicitAny: contract blocks are untyped JSON
  let {
    blocks = [] as any[],
    /**
     * Where a data block asks for its next window, e.g.
     * `/ext/content/pages/cms/home/blocks`. The block's id is appended.
     *
     * Optional: without it a data block shows the first window and no paging
     * controls, which is what a consumer embedding blocks outside a Zveltio host
     * gets. The route it points at re-reads the block from the stored page, so
     * handing this over grants no query the page did not already contain.
     */
    blocksBaseUrl = '',
    /**
     * Set when this instance is drawing a container's children rather than a
     * whole page: the page wrapper's padding and max-width belong to the page,
     * not to every nesting level inside it.
     */
    nested = false,
    /** Gap between a container's children. */
    gap = 'md',
    /**
     * The record a RECORD page shows, if this is one.
     *
     * When present, every block is bound against it before drawing — so
     * `{{title}}` in a hero, or `{{price}}` in a button label, resolves to this
     * row. The substitution and its escaping rules are the ones an item
     * template already uses; the only new idea is that a page can have a
     * current record at all.
     */
    record = null as Record<string, any> | null,
  } = $props();

  /**
   * Blocks as drawn: bound to the record when there is one, untouched otherwise.
   *
   * Bound once here rather than per block, so a nested container's children are
   * covered by the same pass — `bindBlock` already recurses.
   */
  const drawn = $derived(
    record ? blocks.map((b, i) => bindBlock(b, record, `r${i}`)) : blocks,
  );

  function headingTag(level: unknown): 'h1' | 'h2' | 'h3' | 'h4' {
    const n = Number(level);
    return (['h1', 'h1', 'h2', 'h3', 'h4'][n] ?? 'h2') as 'h1' | 'h2' | 'h3' | 'h4';
  }

  const BTN: Record<string, string> = {
    primary: 'btn btn-primary',
    secondary: 'btn btn-secondary',
    dark: 'btn btn-neutral',
    light: 'btn',
    ghost: 'btn btn-ghost',
    link: 'btn btn-link',
  };

  /**
   * Reveal animated blocks as they scroll into view.
   *
   * Only ever ADDS a class. The stylesheet's resting state is visible, and
   * `zv-anim` hides a block only once `zv-anim-armed` is on the page — set here,
   * on mount. So a visitor whose script never ran, or ran late, sees every
   * block; the animation is an enhancement and cannot become a blank page.
   */
  let root: HTMLElement | undefined = $state();

  onMount(() => {
    if (!root) return;
    const animated = root.querySelectorAll<HTMLElement>('.zv-anim');
    if (animated.length === 0) return;

    root.classList.add('zv-anim-armed');

    if (typeof IntersectionObserver === 'undefined') {
      for (const el of animated) el.classList.add('zv-seen');
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('zv-seen');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    for (const el of animated) io.observe(el);
    return () => io.disconnect();
  });

  /** Container gap, as whole class names — see the note on `col-span-`. */
  const GAP: Record<string, string> = {
    none: 'gap-0', sm: 'gap-2', md: 'gap-6', lg: 'gap-10',
  };

  /**
   * Column counts, also as whole class names.
   *
   * `grid-cols-{n}` built by interpolation does not exist: Tailwind scans source
   * text for complete class names at build time, so an interpolated one is never
   * generated and the grid silently collapses to one column.
   */
  const COLS: Record<number, string> = {
    1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-4', 5: 'sm:grid-cols-5', 6: 'sm:grid-cols-6',
  };
  function colsClass(n: unknown, fallback: number, max: number): string {
    return COLS[Math.min(Math.max(Number(n) || fallback, 1), max)] ?? COLS[fallback];
  }

  // Width and spacing across the three device sizes live in `responsive.ts`:
  // whole Tailwind class names for the width, CSS custom properties plus the
  // static stylesheet below for everything else.
</script>

<!--
  A twelve-column grid, so `col_span` means what it says. A page whose blocks
  are all full width looks exactly as it did when this was a vertical stack.
-->
<div bind:this={root} class={nested
  ? `grid grid-cols-12 items-start ${GAP[gap] ?? GAP.md}`
  : 'mx-auto max-w-5xl px-4 sm:px-6 py-10 grid grid-cols-12 gap-6 items-start'}>
  {#each drawn as block, i (block.id ?? i)}
    {@const c = block.content ?? {}}
    {@const mo = motionAttrs(block)}
    <div class="zv-b {spanClasses(block)} {mo.class}" style={styleVars(block) ? `${styleVars(block)};${mo.style}` : mo.style}>

      {#if block.type === 'hero'}
        <div class="rounded-xl px-6 py-14 text-center"
          style:background-color={c.bg_color ?? 'var(--fallback-b2,#f2f2f2)'}
          style:color={c.text_color ?? 'inherit'}>
          {#if c.image_url}
            <img src={c.image_url} alt={c.title ?? ''} class="mx-auto mb-6 max-w-sm rounded-lg" />
          {/if}
          <h1 class="text-4xl sm:text-5xl font-bold tracking-tight">{c.title ?? ''}</h1>
          {#if c.subtitle}<p class="mt-4 text-lg opacity-80">{c.subtitle}</p>{/if}
          {#if c.cta_text}
            <a href={c.cta_url ?? '#'} class="btn btn-primary mt-6">{c.cta_text}</a>
          {/if}
        </div>

      {:else if block.type === 'heading'}
        <svelte:element this={headingTag(c.level)} class="font-bold tracking-tight
          {c.level === 1 ? 'text-4xl sm:text-5xl' : c.level === 2 ? 'text-3xl' : 'text-2xl'}">
          {c.text ?? ''}
        </svelte:element>

      <!-- `text` is the textarea editor's name and keeps its `html` field;
           `richtext` is the builder's and keeps `content`. -->
      {:else if block.type === 'text' || block.type === 'richtext'}
        <div class="prose max-w-none">{@html safeHtml(c.html ?? c.content ?? '')}</div>

      {:else if block.type === 'image'}
        {@const src = c.url ?? c.src}
        {#if src}
          <figure>
            {#if c.link}
              <a href={c.link}><img {src} alt={c.alt ?? ''} class="rounded-lg max-w-full h-auto"
                style={c.width ? `width:${c.width}` : undefined} /></a>
            {:else}
              <img {src} alt={c.alt ?? ''} class="rounded-lg max-w-full h-auto"
                style={c.width ? `width:${c.width}` : undefined} />
            {/if}
            {#if c.caption}<figcaption class="text-sm opacity-60 mt-1">{c.caption}</figcaption>{/if}
          </figure>
        {/if}

      {:else if block.type === 'button'}
        <a href={c.href ?? c.url ?? '#'} class={BTN[c.variant as string] ?? 'btn btn-primary'}>
          {c.label ?? c.text ?? 'Button'}
        </a>

      {:else if block.type === 'cta'}
        <div class="rounded-xl bg-base-200 px-6 py-10 text-center">
          {#if c.heading}<h2 class="text-2xl font-bold">{c.heading}</h2>{/if}
          {#if c.text}<p class="mt-2 opacity-70">{c.text}</p>{/if}
          {#if c.button_text}
            <a href={c.button_url ?? '#'} class="{BTN[c.variant as string] ?? 'btn btn-primary'} mt-5">
              {c.button_text}
            </a>
          {/if}
        </div>

      {:else if block.type === 'columns'}
        <div class="grid gap-6 {colsClass(c.count, 2, 4)}">
          {#each (Array.isArray(c.items) ? c.items : []) as col, j (j)}
            <div class="prose max-w-none">{@html safeHtml(String(col ?? ''))}</div>
          {/each}
        </div>

      {:else if block.type === 'stats'}
        <div class="grid gap-4 grid-cols-2 {colsClass(c.columns, 4, 6)}">
          {#each (Array.isArray(c.items) ? c.items : []) as s, j (j)}
            <div class="rounded-lg border border-base-300 px-4 py-5 text-center">
              <p class="text-3xl font-bold">{s.value ?? ''}</p>
              <p class="text-sm opacity-60 mt-1">{s.label ?? ''}</p>
            </div>
          {/each}
        </div>

      {:else if block.type === 'video'}
        {#if c.url}
          <figure>
            <div class="aspect-video">
              <iframe src={c.url} title={c.caption ?? 'video'} class="w-full h-full rounded-lg"
                allowfullscreen frameborder="0"></iframe>
            </div>
            {#if c.caption}<figcaption class="text-sm opacity-60 mt-1">{c.caption}</figcaption>{/if}
          </figure>
        {/if}

      {:else if block.type === 'gallery'}
        <div class="grid gap-3 grid-cols-2 {colsClass(c.columns, 3, 6)}">
          {#each (Array.isArray(c.images) ? c.images : []) as img, j (j)}
            {#if img?.url}
              <img src={img.url} alt={img.alt ?? ''} class="rounded-lg w-full h-auto" />
            {/if}
          {/each}
        </div>

      <!-- `html` is the legacy name and carries `code`; `embed` is the
           builder's and carries `html`. Both are raw authored markup. -->
      {:else if block.type === 'html' || block.type === 'embed'}
        <div>{@html safeHtml(c.code ?? c.html ?? '')}</div>

      {:else if block.type === 'icon'}
        {@const d = ICONS[String(c.name ?? 'star')]}
        {#if d}
          <div class="inline-flex items-center gap-2">
            <svg width={Number(c.size) || 32} height={Number(c.size) || 32}
              viewBox="0 0 24 24" fill="none" stroke={c.color || 'currentColor'}
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              role={c.label ? 'img' : 'presentation'} aria-label={c.label || undefined}
              aria-hidden={c.label ? undefined : 'true'}>
              <path d={d} />
            </svg>
            {#if c.label}<span>{c.label}</span>{/if}
          </div>
        {/if}

      {:else if block.type === 'divider'}
        <hr class="border-base-300" style:border-top-width={c.thickness ? `${c.thickness}px` : undefined}
          style:border-color={c.color ?? undefined} />

      {:else if block.type === 'spacer'}
        <div style:height={`${Number(c.height) || 48}px`}></div>

      {:else if block.type === 'container'}
        <!--
          A container is a twelve-column grid of its own, so `col_span` means the
          same thing at every depth. This is what replaced the `columns` block,
          which held raw HTML strings and therefore could not contain an image, a
          data block, or anything else the builder makes.
        -->
        <!--
          The record is NOT passed down: the parent pass already bound every
          nested block, and binding twice would substitute into text that a
          record value had just produced.
        -->
        <Self
          blocks={Array.isArray(c.children) ? c.children : []}
          {blocksBaseUrl}
          nested
          gap={c.gap ?? 'md'}
        />

      {:else if block.type === 'collection_list'}
        {#snippet item(row, i)}
          <!--
            `bindBlock` substitutes the record's values into the template and
            escapes every one of them: the template is authored markup and was
            sanitised on the way in, the values are data and never were.
          -->
          <Self blocks={[bindBlock(c.item_template, row, i)]} {blocksBaseUrl} nested gap="none" />
        {/snippet}

        <CollectionList
          {...c}
          rowsUrl={blocksBaseUrl && block.id ? `${blocksBaseUrl}/${block.id}/rows` : ''}
          renderItem={c.view_type === 'template' && c.item_template ? item : undefined}
        />

      {:else}
        <div class="rounded-lg border border-dashed border-base-300 p-4 text-sm opacity-50">
          Unsupported block: {block.type}
        </div>
      {/if}

    </div>
  {/each}
</div>

<style>
  /*
    The responsive half of a block's styling.
    Written once and interpolating NOTHING: the values arrive as CSS custom
    properties on each block's inline style, already validated in
    `responsive.ts`. Generating a rule per block out of authored values would
    mean building CSS text from a free-text colour field, on a public page.
    Each size falls back to the smaller one, so an override set only for desktop
    still inherits the base everywhere below it.
  */
  :global(.zv-b) {
    padding-top: var(--zv-pt, 0);
    padding-bottom: var(--zv-pb, 0);
    padding-left: var(--zv-pl, 0);
    padding-right: var(--zv-pr, 0);
    margin-top: var(--zv-mt, 0);
    margin-bottom: var(--zv-mb, 0);
    border-radius: var(--zv-br, 0);
    background-color: var(--zv-bg, transparent);
    color: var(--zv-fg, inherit);
    text-align: var(--zv-ta, inherit);
  }

  @media (min-width: 640px) {
    :global(.zv-b) {
      padding-top: var(--zv-pt-sm, var(--zv-pt, 0));
      padding-bottom: var(--zv-pb-sm, var(--zv-pb, 0));
      padding-left: var(--zv-pl-sm, var(--zv-pl, 0));
      padding-right: var(--zv-pr-sm, var(--zv-pr, 0));
      margin-top: var(--zv-mt-sm, var(--zv-mt, 0));
      margin-bottom: var(--zv-mb-sm, var(--zv-mb, 0));
      border-radius: var(--zv-br-sm, var(--zv-br, 0));
      background-color: var(--zv-bg-sm, var(--zv-bg, transparent));
      color: var(--zv-fg-sm, var(--zv-fg, inherit));
      text-align: var(--zv-ta-sm, var(--zv-ta, inherit));
    }
  }

  /*
    Motion. The resting state is VISIBLE — `zv-anim` only hides a block once the
    renderer has added `zv-anim-armed`, which it does on mount. A page whose
    script failed shows everything.
  */
  :global(.zv-anim-armed .zv-anim) {
    opacity: 0;
    transition:
      opacity var(--zv-anim-dur, 500ms) ease-out var(--zv-anim-delay, 0ms),
      transform var(--zv-anim-dur, 500ms) ease-out var(--zv-anim-delay, 0ms);
  }
  :global(.zv-anim-armed .zv-anim-up)    { transform: translateY(24px); }
  :global(.zv-anim-armed .zv-anim-down)  { transform: translateY(-24px); }
  :global(.zv-anim-armed .zv-anim-left)  { transform: translateX(24px); }
  :global(.zv-anim-armed .zv-anim-right) { transform: translateX(-24px); }
  :global(.zv-anim-armed .zv-anim-zoom)  { transform: scale(0.94); }

  :global(.zv-anim.zv-seen) {
    opacity: 1;
    transform: none;
  }

  :global(.zv-sticky) {
    position: sticky;
    top: var(--zv-sticky-top, 0px);
    z-index: 20;
  }

  /*
    A visitor who asked for less motion gets none, and gets it without a reload —
    which is why this lives in the stylesheet and not in the code that decides
    the classes.
  */
  @media (prefers-reduced-motion: reduce) {
    :global(.zv-anim-armed .zv-anim) {
      opacity: 1 !important;
      transform: none !important;
      transition: none !important;
    }
  }

  @media (min-width: 1024px) {
    :global(.zv-b) {
      padding-top: var(--zv-pt-lg, var(--zv-pt-sm, var(--zv-pt, 0)));
      padding-bottom: var(--zv-pb-lg, var(--zv-pb-sm, var(--zv-pb, 0)));
      padding-left: var(--zv-pl-lg, var(--zv-pl-sm, var(--zv-pl, 0)));
      padding-right: var(--zv-pr-lg, var(--zv-pr-sm, var(--zv-pr, 0)));
      margin-top: var(--zv-mt-lg, var(--zv-mt-sm, var(--zv-mt, 0)));
      margin-bottom: var(--zv-mb-lg, var(--zv-mb-sm, var(--zv-mb, 0)));
      border-radius: var(--zv-br-lg, var(--zv-br-sm, var(--zv-br, 0)));
      background-color: var(--zv-bg-lg, var(--zv-bg-sm, var(--zv-bg, transparent)));
      color: var(--zv-fg-lg, var(--zv-fg-sm, var(--zv-fg, inherit)));
      text-align: var(--zv-ta-lg, var(--zv-ta-sm, var(--zv-ta, inherit)));
    }
  }
</style>
