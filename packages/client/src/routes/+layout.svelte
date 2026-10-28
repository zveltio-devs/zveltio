<script lang="ts">
import { m } from '#lib/i18n.svelte.js';
import '../app.css';
import OfflineBanner from '#lib/components/common/OfflineBanner.svelte';
import { page } from '$app/state';
import { Menu, X, LogIn } from '@lucide/svelte';
import { safeCss, safeImageUrl } from '#lib/sanitize.js';
import { themeName, themeStyle } from '@zveltio/ui/theme';

let { children, data } = $props();

const theme = $derived(data?.theme ?? null);
const nav = $derived(data?.nav ?? []);

// The theme as data (ADR 0007): daisyUI tokens set as CSS variables by the
// kit, which drops any value that is not a colour, a length or a known name.
const tokens = $derived(data?.tokens ?? null);

let mobileMenuOpen = $state(false);

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

<div class="min-h-screen flex font-sans bg-base-100 text-base-content {isSidebar ? 'flex-row' : 'flex-col'}" data-theme={themeName(tokens)} style={themeStyle(tokens)}>

  {#if showNav}
    <!-- Sidebar nav -->
    {#if isSidebar}
      <aside class="w-60 shrink-0 border-r border-primary-content/15 flex flex-col bg-primary text-primary-content">
        <div class="p-4 border-b border-primary-content/10">
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
              class="flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors hover:bg-primary-content/10 {isActive(item.slug) ? 'bg-primary-content/20' : ''}"
            >
              {item.title}
            </a>
          {/each}
        </nav>
        <div class="p-3 border-t border-primary-content/10">
          <a href="/auth/login" class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm hover:bg-primary-content/10 transition-colors">
            <LogIn size={14}/>{m['auth.sign_in']()}</a>
        </div>
      </aside>

    <!-- Top nav -->
    {:else}
      <header class="shrink-0 border-b border-base-300 shadow-sm bg-primary text-primary-content">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-4">
          <!-- Brand -->
          <a href="/" class="flex items-center gap-2 shrink-0">
            {#if theme?.logo_url}
              <img src={safeImageUrl(theme.logo_url)} alt={theme.app_name ?? ''} class="h-8 w-auto"/>
            {:else}
              <span class="font-bold text-lg">{theme?.app_name ?? m['home.default_name']()}</span>
            {/if}
          </a>

          <!-- Desktop nav links -->
          <nav class="hidden md:flex items-center gap-1 flex-1 ml-2">
            {#each nav as item}
              <a
                href="/{item.slug === '/' ? '' : item.slug}"
                class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-primary-content/20 {isActive(item.slug) ? 'bg-primary-content/25' : ''}"
              >
                {item.title}
              </a>
            {/each}
          </nav>

          <div class="ml-auto flex items-center gap-2">
            <a href="/auth/login" class="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-primary-content/20 transition-colors">
              <LogIn size={14}/>{m['auth.sign_in']()}</a>
            <!-- Mobile hamburger -->
            <button class="md:hidden btn btn-ghost btn-sm text-primary-content" onclick={() => mobileMenuOpen = !mobileMenuOpen}>
              {#if mobileMenuOpen}<X size={18}/>{:else}<Menu size={18}/>{/if}
            </button>
          </div>
        </div>

        <!-- Mobile nav -->
        {#if mobileMenuOpen}
          <nav class="md:hidden border-t border-primary-content/20 px-4 py-2 flex flex-col gap-0.5 bg-primary">
            {#each nav as item}
              <a
                href="/{item.slug === '/' ? '' : item.slug}"
                class="px-3 py-2 rounded-lg text-sm hover:bg-primary-content/20"
                onclick={() => mobileMenuOpen = false}
              >
                {item.title}
              </a>
            {/each}
            <a href="/auth/login" class="px-3 py-2 rounded-lg text-sm hover:bg-primary-content/20 flex items-center gap-1.5">
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
    <footer class="shrink-0 border-t border-base-300 py-4 px-6 text-center text-sm opacity-50">
      © {new Date().getFullYear()} {theme.app_name}
    </footer>
  {/if}
</div>
