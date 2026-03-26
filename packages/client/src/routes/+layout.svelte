<script lang="ts">
  import '../app.css';
  import OfflineBanner from '$components/common/OfflineBanner.svelte';
  import { page } from '$app/state';
  import { Menu, X, LogIn } from '@lucide/svelte';

  let { children, data } = $props();

  const theme = $derived(data?.theme ?? null);
  const nav = $derived(data?.nav ?? []);

  // Build CSS variables from theme (DB columns: color_primary, color_base_100, etc.)
  const themeStyle = $derived(theme ? `
    --color-primary: ${theme.color_primary ?? '#570df8'};
    --color-secondary: ${theme.color_secondary ?? '#f000b8'};
    --color-accent: ${theme.color_accent ?? '#37cdbe'};
    --color-bg: ${theme.color_base_100 ?? '#ffffff'};
    --color-text: ${theme.color_neutral ?? '#3d4451'};
    --radius: ${theme.border_radius ?? '0.5rem'};
    font-family: ${theme.font_family ?? 'system-ui, sans-serif'};
    font-size: ${theme.font_size_base ?? '16px'};
    background-color: ${theme.color_base_100 ?? ''};
    color: ${theme.color_neutral ?? ''};
  ` : '');

  let mobileMenuOpen = $state(false);

  const showNav = $derived((theme?.nav_position ?? 'top') !== 'none' && nav.length > 0);
  const isSidebar = $derived(theme?.nav_position === 'sidebar');

  function isActive(href: string) {
    return page.url.pathname === href || page.url.pathname === `/${href}`;
  }
</script>

<svelte:head>
  {#if theme?.meta_title}<title>{theme.meta_title}</title>{/if}
  {#if theme?.meta_description}<meta name="description" content={theme.meta_description}/>{/if}
  {#if theme?.favicon_url}<link rel="icon" href={theme.favicon_url}/>{/if}
  {#if theme?.custom_css}<style>{theme.custom_css}</style>{/if}
</svelte:head>

<OfflineBanner />

<div class="min-h-screen flex {isSidebar ? 'flex-row' : 'flex-col'}" style={themeStyle}>

  {#if showNav}
    <!-- Sidebar nav -->
    {#if isSidebar}
      <aside class="w-60 shrink-0 border-r flex flex-col" style="background: {theme?.color_primary ?? '#570df8'}; color: white; border-color: rgba(255,255,255,0.15)">
        <div class="p-4 border-b border-white/10">
          {#if theme?.logo_url}
            <img src={theme.logo_url} alt={theme.app_name ?? ''} class="h-8 w-auto"/>
          {:else}
            <span class="font-bold text-lg">{theme?.app_name ?? ''}</span>
          {/if}
        </div>
        <nav class="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {#each nav as item}
            <a
              href="/{item.slug === '/' ? '' : item.slug}"
              class="flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors hover:bg-white/10 {isActive(item.slug) ? 'bg-white/20' : ''}"
            >
              {item.title}
            </a>
          {/each}
        </nav>
        <div class="p-3 border-t border-white/10">
          <a href="/auth/login" class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm hover:bg-white/10 transition-colors">
            <LogIn size={14}/> Sign In
          </a>
        </div>
      </aside>

    <!-- Top nav -->
    {:else}
      <header class="shrink-0 border-b shadow-sm" style="background: {theme?.color_primary ?? '#570df8'}; color: white; border-color: rgba(0,0,0,0.1)">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-4">
          <!-- Brand -->
          <a href="/" class="flex items-center gap-2 shrink-0">
            {#if theme?.logo_url}
              <img src={theme.logo_url} alt={theme.app_name ?? ''} class="h-8 w-auto"/>
            {:else}
              <span class="font-bold text-lg">{theme?.app_name ?? 'Portal'}</span>
            {/if}
          </a>

          <!-- Desktop nav links -->
          <nav class="hidden md:flex items-center gap-1 flex-1 ml-2">
            {#each nav as item}
              <a
                href="/{item.slug === '/' ? '' : item.slug}"
                class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-white/20 {isActive(item.slug) ? 'bg-white/25' : ''}"
              >
                {item.title}
              </a>
            {/each}
          </nav>

          <div class="ml-auto flex items-center gap-2">
            <a href="/auth/login" class="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-white/20 transition-colors">
              <LogIn size={14}/> Sign In
            </a>
            <!-- Mobile hamburger -->
            <button class="md:hidden btn btn-ghost btn-sm text-white" onclick={() => mobileMenuOpen = !mobileMenuOpen}>
              {#if mobileMenuOpen}<X size={18}/>{:else}<Menu size={18}/>{/if}
            </button>
          </div>
        </div>

        <!-- Mobile nav -->
        {#if mobileMenuOpen}
          <nav class="md:hidden border-t border-white/20 px-4 py-2 flex flex-col gap-0.5" style="background: {theme?.color_primary ?? '#570df8'}">
            {#each nav as item}
              <a
                href="/{item.slug === '/' ? '' : item.slug}"
                class="px-3 py-2 rounded-lg text-sm hover:bg-white/20"
                onclick={() => mobileMenuOpen = false}
              >
                {item.title}
              </a>
            {/each}
            <a href="/auth/login" class="px-3 py-2 rounded-lg text-sm hover:bg-white/20 flex items-center gap-1.5">
              <LogIn size={13}/> Sign In
            </a>
          </nav>
        {/if}
      </header>
    {/if}
  {/if}

  <!-- Main content -->
  <main class="flex-1 min-w-0">
    {@render children()}
  </main>

  <!-- Footer -->
  {#if theme?.footer_text}
    <footer class="shrink-0 border-t py-4 px-6 text-center text-sm opacity-50" style="border-color: var(--color-text, #111827)20">
      {theme.footer_text}
    </footer>
  {/if}
</div>
