<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import '../app.css';
import OfflineBanner from '$components/common/OfflineBanner.svelte';
import { page } from '$app/state';
import { Menu, X, LogIn } from '@lucide/svelte';
import { safeCss, safeImageUrl } from '$lib/sanitize';

let { children, data } = $props();

const theme = $derived(data?.theme ?? null);
const nav = $derived(data?.nav ?? []);

// CSS variables from the site's branding. The zone table this once read had a
// full palette (base_100, neutral, accent, radius, font); the site row that
// replaced it carries two colours, so the rest are the defaults they always
// fell back to and are written as such rather than read off a column that no
// longer exists.
//
// `safeCss` because these are operator-supplied strings landing in a style
// attribute: Svelte escapes the attribute for HTML, which does not stop a
// value from closing its declaration and adding `background:url(https://…)`.
const themeStyle = $derived(
  theme
    ? safeCss(`
    --color-primary: ${theme.color_primary ?? '#570df8'};
    --color-secondary: ${theme.color_secondary ?? '#f000b8'};
    --color-accent: #37cdbe;
    --color-bg: #ffffff;
    --color-text: #3d4451;
    --radius: 0.5rem;
    font-family: system-ui, sans-serif;
    font-size: 16px;
  `)
    : '',
);

let mobileMenuOpen = $state(false);

// Same reason as `themeStyle`: the value is operator-supplied and lands inside
// a style attribute, where escaping stops injection into markup but not into
// CSS. `safeCss` drops the constructs that reach the network.
const primary = $derived(safeCss(theme?.color_primary ?? '').trim() || '#570df8');

const showNav = $derived((theme?.nav_position ?? 'top') !== 'none' && nav.length > 0);
const isSidebar = $derived(theme?.nav_position === 'sidebar');

function isActive(href: string) {
  return page.url.pathname === href || page.url.pathname === `/${href}`;
}
</script>

<svelte:head>
  {#if theme?.app_name}<title>{theme.app_name}</title>{/if}
  {#if theme?.custom_css}<style>{safeCss(theme.custom_css)}</style>{/if}
</svelte:head>

<OfflineBanner />

<div class="min-h-screen flex {isSidebar ? 'flex-row' : 'flex-col'}" style={themeStyle}>

  {#if showNav}
    <!-- Sidebar nav -->
    {#if isSidebar}
      <aside class="w-60 shrink-0 border-r flex flex-col" style="background: {primary}; color: white; border-color: rgba(255,255,255,0.15)">
        <div class="p-4 border-b border-white/10">
          {#if theme?.logo_url}
            <img src={safeImageUrl(theme.logo_url)} alt={theme.app_name ?? ''} class="h-8 w-auto"/>
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
            <LogIn size={14}/>{m['auth.sign_in']()}</a>
        </div>
      </aside>

    <!-- Top nav -->
    {:else}
      <header class="shrink-0 border-b shadow-sm" style="background: {primary}; color: white; border-color: rgba(0,0,0,0.1)">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-4">
          <!-- Brand -->
          <a href="/" class="flex items-center gap-2 shrink-0">
            {#if theme?.logo_url}
              <img src={safeImageUrl(theme.logo_url)} alt={theme.app_name ?? ''} class="h-8 w-auto"/>
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
              <LogIn size={14}/>{m['auth.sign_in']()}</a>
            <!-- Mobile hamburger -->
            <button class="md:hidden btn btn-ghost btn-sm text-white" onclick={() => mobileMenuOpen = !mobileMenuOpen}>
              {#if mobileMenuOpen}<X size={18}/>{:else}<Menu size={18}/>{/if}
            </button>
          </div>
        </div>

        <!-- Mobile nav -->
        {#if mobileMenuOpen}
          <nav class="md:hidden border-t border-white/20 px-4 py-2 flex flex-col gap-0.5" style="background: {primary}">
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
              <LogIn size={13}/>{m['auth.sign_in']()}</a>
          </nav>
        {/if}
      </header>
    {/if}
  {/if}

  <!-- Main content -->
  <main class="flex-1 min-w-0">
    {@render children()}
  </main>

  <!--
    Footer. `footer_text` was a zone column; the site row that replaced zones
    has no such field, so the name is the only thing left to show and the
    footer renders only once there is one.
  -->
  {#if theme?.app_name}
    <footer class="shrink-0 border-t py-4 px-6 text-center text-sm opacity-50" style="border-color: var(--color-text, #111827)20">
      © {new Date().getFullYear()} {theme.app_name}
    </footer>
  {/if}
</div>
