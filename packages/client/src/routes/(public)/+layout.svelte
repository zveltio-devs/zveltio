<script lang="ts">
// Public site chrome: header with the CMS-managed 'main' menu, footer with
// 'footer'. Menus come from /ext/content/page-builder/cms/nav (see +layout.ts);
// theming is a single accent custom property from public settings.
let { data, children } = $props();

type MenuItem = { label: string; slug?: string; url?: string; external?: boolean };
const hrefOf = (i: MenuItem) => (i.url ? i.url : `/${i.slug === 'home' ? '' : (i.slug ?? '')}`);
const main: MenuItem[] = $derived(data.menus?.main ?? []);
const footer: MenuItem[] = $derived(data.menus?.footer ?? []);
</script>

<div
  class="min-h-screen flex flex-col bg-base-100"
  style={data.site?.themeColor ? `--site-accent: ${data.site.themeColor}` : ''}
>
  {#if main.length > 0 || data.site?.name}
    <header class="border-b border-base-300 bg-base-100/90 backdrop-blur sticky top-0 z-30">
      <div class="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-6">
        <a href="/" class="flex items-center gap-2 font-semibold text-lg">
          {#if data.site?.logoUrl}
            <img src={data.site.logoUrl} alt={data.site?.name ?? 'Logo'} class="h-7 w-auto" />
          {:else}
            <span style="color: var(--site-accent, inherit)">{data.site?.name ?? ''}</span>
          {/if}
        </a>
        {#if main.length > 0}
          <nav class="flex items-center gap-5 overflow-x-auto">
            {#each main as item (item.label)}
              <a
                href={hrefOf(item)}
                target={item.external ? '_blank' : undefined}
                rel={item.external ? 'noopener' : undefined}
                class="text-sm text-base-content/70 hover:text-base-content whitespace-nowrap"
              >
                {item.label}
              </a>
            {/each}
          </nav>
        {/if}
      </div>
    </header>
  {/if}

  <main class="flex-1">
    {@render children()}
  </main>

  {#if footer.length > 0 || data.site?.name}
    <footer class="border-t border-base-300 py-6 mt-8">
      <div class="max-w-5xl mx-auto px-4 flex flex-wrap items-center justify-between gap-4 text-sm text-base-content/60">
        <span>© {new Date().getFullYear()} {data.site?.name ?? ''}</span>
        {#if footer.length > 0}
          <nav class="flex items-center gap-4 flex-wrap">
            {#each footer as item (item.label)}
              <a
                href={hrefOf(item)}
                target={item.external ? '_blank' : undefined}
                rel={item.external ? 'noopener' : undefined}
                class="hover:text-base-content"
              >
                {item.label}
              </a>
            {/each}
          </nav>
        {/if}
      </div>
    </footer>
  {/if}
</div>
