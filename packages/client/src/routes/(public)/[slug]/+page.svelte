<script lang="ts">
  import { error } from '@sveltejs/kit';
  import { untrack } from 'svelte';

  let { data } = $props();

  if (untrack(() => data.status === 404 || !data.portalPage)) {
    error(404, 'Page not found');
  }

  const visibleSections = $derived(
    (data.sections ?? []).filter((s: any) => s.is_visible !== false)
  );
</script>

<svelte:head>
  <title>{data.portalPage?.title ?? 'Page'}</title>
  {#if data.portalPage?.description}
    <meta name="description" content={data.portalPage.description}/>
  {/if}
</svelte:head>

<!-- 12-column portal grid -->
<div class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
  <div class="grid grid-cols-12 gap-6">
    {#each visibleSections as section (section.id)}
      <div class="col-span-12 {colClass(section.col_span)}">
        {#if section.view_type === 'hero'}
          <HeroBlock config={section.config} title={section.title}/>
        {:else if section.view_type === 'collection'}
          <CollectionBlock config={section.config} title={section.title} records={section._records ?? []} fields={section._fields ?? []}/>
        {:else if section.view_type === 'markdown'}
          <MarkdownBlock config={section.config} title={section.title}/>
        {:else if section.view_type === 'stats'}
          <StatsBlock config={section.config} title={section.title}/>
        {:else if section.view_type === 'grid'}
          <GridBlock config={section.config} title={section.title}/>
        {:else if section.view_type === 'columns'}
          <ColumnsBlock config={section.config} title={section.title}/>
        {:else}
          <!-- Unknown section type: render generic card -->
          <div class="rounded-xl border p-4 text-sm opacity-50">
            Section: {section.view_type}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<script lang="ts" module>
  function colClass(span: number | undefined): string {
    const s = span ?? 12;
    const map: Record<number, string> = {
      1: 'sm:col-span-1', 2: 'sm:col-span-2', 3: 'sm:col-span-3',
      4: 'sm:col-span-4', 5: 'sm:col-span-5', 6: 'sm:col-span-6',
      7: 'sm:col-span-7', 8: 'sm:col-span-8', 9: 'sm:col-span-9',
      10: 'sm:col-span-10', 11: 'sm:col-span-11', 12: 'sm:col-span-12',
    };
    return map[s] ?? 'sm:col-span-12';
  }
</script>

<!-- ── Inline section components ────────────────────────────────────────────── -->

{#snippet HeroBlock({ config, title }: { config: any; title?: string })}
  <div
    class="rounded-2xl overflow-hidden relative flex items-center justify-center min-h-64 text-white text-center p-10"
    style="background: {config.bg_image ? `url(${config.bg_image}) center/cover` : 'var(--color-primary, #6366f1)'};"
  >
    {#if config.bg_image}<div class="absolute inset-0 bg-black/40 rounded-2xl"></div>{/if}
    <div class="relative z-10 space-y-3 max-w-2xl">
      <h1 class="text-3xl sm:text-5xl font-bold leading-tight">{config.heading ?? title ?? 'Welcome'}</h1>
      {#if config.subheading}
        <p class="text-lg opacity-80">{config.subheading}</p>
      {/if}
      {#if config.button_label}
        <div class="pt-2">
          <a
            href={config.button_url ?? '#'}
            class="inline-block px-6 py-3 rounded-xl bg-white font-semibold transition-opacity hover:opacity-90"
            style="color: var(--color-primary, #6366f1); border-radius: var(--radius, 0.75rem)"
          >
            {config.button_label}
          </a>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet CollectionBlock({ config, title, records, fields }: { config: any; title?: string; records: any[]; fields: any[] })}
  <div class="space-y-3">
    {#if title}
      <h2 class="text-xl font-bold" style="color: var(--color-text, #111827)">{title}</h2>
    {/if}
    {#if records.length === 0}
      <p class="text-sm opacity-40 py-4 text-center">No records found.</p>
    {:else}
      <!-- Responsive card grid or table based on config.view_type -->
      {#if config.view_type === 'gallery' || config.view_type === 'grid'}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {#each records as row (row.id)}
            {@const titleField = fields.find((f: any) => ['name','title','label'].includes(f.name))}
            {@const imgField = fields.find((f: any) => f.type === 'image' || f.type === 'url')}
            <div class="rounded-xl border overflow-hidden hover:shadow-md transition-shadow" style="border-color: var(--color-text, #111)15; border-radius: var(--radius, 0.5rem)">
              {#if imgField && row[imgField.name]}
                <img src={row[imgField.name]} alt="" class="w-full h-40 object-cover"/>
              {:else}
                <div class="h-28 flex items-center justify-center text-4xl font-bold opacity-10" style="background: var(--color-primary, #6366f1)20">
                  {String(row[titleField?.name] ?? '?').charAt(0).toUpperCase()}
                </div>
              {/if}
              <div class="p-3">
                <p class="font-semibold text-sm">{row[titleField?.name] ?? row.id}</p>
                {#each fields.filter((f: any) => !f.is_system && f.name !== titleField?.name).slice(0, 2) as f}
                  <p class="text-xs opacity-50 truncate mt-0.5">{row[f.name] ?? '—'}</p>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <!-- Table view -->
        <div class="overflow-x-auto rounded-xl border" style="border-color: var(--color-text, #111)10">
          <table class="w-full text-sm">
            <thead>
              <tr style="background: var(--color-primary, #6366f1)10">
                {#each fields.filter((f: any) => !f.is_system) as f}
                  <th class="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wide opacity-60">{f.display_name ?? f.name}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each records as row (row.id)}
                <tr class="border-t hover:bg-black/2 transition-colors" style="border-color: var(--color-text, #111)8">
                  {#each fields.filter((f: any) => !f.is_system) as f}
                    <td class="px-4 py-2.5 max-w-xs truncate">{row[f.name] ?? '—'}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet MarkdownBlock({ config, title }: { config: any; title?: string })}
  <div class="prose max-w-none" style="color: var(--color-text, #111827)">
    {#if title}<h2>{title}</h2>{/if}
    <!-- Content is raw HTML/markdown; engine should sanitize before storing -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html config.content ?? ''}
  </div>
{/snippet}

{#snippet StatsBlock({ config, title }: { config: any; title?: string })}
  <div class="space-y-3">
    {#if title}
      <h2 class="text-xl font-bold" style="color: var(--color-text, #111827)">{title}</h2>
    {/if}
    {#if config._stats}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {#each config._stats as stat}
          <div class="rounded-xl p-4 text-center" style="background: var(--color-primary, #6366f1)10; border-radius: var(--radius, 0.5rem)">
            <p class="text-3xl font-bold" style="color: var(--color-primary, #6366f1)">{stat.value?.toLocaleString() ?? 0}</p>
            <p class="text-sm opacity-60 mt-0.5">{stat.label}</p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet GridBlock({ config, title }: { config: any; title?: string })}
  <div class="space-y-3">
    {#if title}
      <h2 class="text-xl font-bold" style="color: var(--color-text, #111827)">{title}</h2>
    {/if}
    {#if config.items?.length}
      <div class="grid gap-4" style="grid-template-columns: repeat({config.columns ?? 3}, 1fr)">
        {#each config.items as item}
          <div class="rounded-xl p-4 border" style="border-color: var(--color-text,#111)10; border-radius: var(--radius, 0.5rem)">
            {#if item.image}<img src={item.image} alt={item.title} class="w-full h-32 object-cover rounded-lg mb-3"/>{/if}
            {#if item.title}<p class="font-semibold">{item.title}</p>{/if}
            {#if item.text}<p class="text-sm opacity-60 mt-1">{item.text}</p>{/if}
            {#if item.href}<a href={item.href} class="text-sm font-medium mt-2 inline-block" style="color: var(--color-primary,#6366f1)">{item.link_label ?? 'Learn more →'}</a>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet ColumnsBlock({ config, title }: { config: any; title?: string })}
  <div class="space-y-3">
    {#if title}
      <h2 class="text-xl font-bold" style="color: var(--color-text, #111827)">{title}</h2>
    {/if}
    {#if config.columns?.length}
      <div class="grid gap-6" style="grid-template-columns: repeat({config.columns.length}, 1fr)">
        {#each config.columns as col}
          <div class="prose max-w-none text-sm" style="color: var(--color-text, #111827)">
            {#if col.heading}<h3 class="font-bold mb-1 not-prose">{col.heading}</h3>{/if}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html col.content ?? ''}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}
