<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import { LogOut, Sun, Moon, Menu, X } from '@lucide/svelte';
  import ToastContainer from '$lib/components/common/ToastContainer.svelte';

  let { children } = $props();
  let mobileOpen = $state(false);
  let dark = $state(false);

  // Zone resolved dynamically from /api/zones/:slug/render
  let zone = $state<{ name: string; primary_color: string; site_name: string | null } | null>(null);
  let navPages = $state<{ slug: string; title: string; icon: string | null }[]>([]);

  // The client zone slug — matches zvd_zones.slug = 'client'
  const ZONE_SLUG = 'client';

  $effect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-theme', dark ? 'dark' : 'light');
  });

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    return cur === href || cur.startsWith(href + '/');
  }

  onMount(async () => {
    const t = localStorage.getItem('zveltio-theme');
    if (t) dark = t === 'dark';

    await auth.init();
    if (!auth.isAuthenticated) {
      goto(`${base}/portal-client/login`);
      return;
    }

    try {
      const res = await api.get<{ zone: any; pages: any[] }>(`/api/zones/${ZONE_SLUG}/render`);
      zone = res.zone;
      navPages = (res.pages ?? []).filter((p: any) => p.is_active);
    } catch {
      // Zone not configured yet — show empty nav
    }
  });

  async function signOut() {
    await auth.signOut();
    goto(`${base}/portal-client/login`);
  }

  const primaryColor = $derived(zone?.primary_color ?? '#069494');
  const siteName = $derived(zone?.site_name ?? zone?.name ?? 'Portal');
</script>

{#if auth.loading}
  <div class="flex h-screen items-center justify-center bg-base-100">
    <span class="loading loading-spinner loading-lg text-primary"></span>
  </div>

{:else if auth.isAuthenticated}
  <div class="flex h-screen bg-base-100 overflow-hidden">

    <!-- ─── Sidebar ────────────────────────────────────────── -->
    <aside class="hidden lg:flex flex-col w-64 shrink-0 bg-base-200 border-r border-base-300">

      <!-- Portal header -->
      <div class="flex items-center h-14 px-4 border-b border-base-300 gap-3">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style="background-color: {primaryColor}">
          <span class="text-white font-bold text-sm leading-none">
            {siteName[0]?.toUpperCase() ?? 'P'}
          </span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm leading-none text-base-content truncate">{siteName}</p>
        </div>
      </div>

      <!-- Dynamic nav from Zones API -->
      <nav class="flex-1 overflow-y-auto py-3">
        <div class="px-3 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 select-none">
            Navigation
          </span>
        </div>
        {#each navPages as p}
          {@const href = `${base}/portal-client/${p.slug}`}
          {@const active = isActive(href)}
          <div class="px-2 py-0.5">
            <a
              href={href}
              class="
                flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
                transition-colors duration-100
                {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
              "
            >
              {#if p.icon}
                <span class="text-base leading-none shrink-0">{p.icon}</span>
              {/if}
              <span class="truncate leading-none">{p.title}</span>
            </a>
          </div>
        {/each}
        {#if navPages.length === 0}
          <p class="px-5 py-3 text-xs text-base-content/40">No pages configured.</p>
        {/if}
      </nav>

      <!-- Footer -->
      <div class="shrink-0 border-t border-base-300 px-2 py-2 space-y-0.5">
        <button
          onclick={() => (dark = !dark)}
          class="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
            text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors"
        >
          {#if dark}<Sun size={16} class="shrink-0" /><span>Light Mode</span>
          {:else}<Moon size={16} class="shrink-0" /><span>Dark Mode</span>{/if}
        </button>

        <div class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg">
          <div class="w-8 h-8 rounded-full bg-primary text-primary-content flex items-center justify-center text-xs font-semibold shrink-0">
            {auth.user?.name?.charAt(0).toUpperCase() || 'U'}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-medium leading-none truncate text-base-content">{auth.user?.name || 'User'}</p>
            <p class="text-[11px] text-base-content/45 mt-0.5 truncate">{auth.user?.email}</p>
          </div>
          <button onclick={signOut} title="Sign out" class="btn btn-ghost btn-xs text-base-content/40">
            <LogOut size={13} />
          </button>
        </div>
      </div>
    </aside>

    <!-- ─── Mobile overlay ──────────────────────────────────── -->
    {#if mobileOpen}
      <button class="fixed inset-0 z-40 bg-black/50 lg:hidden cursor-default" aria-label="Close menu" onclick={() => (mobileOpen = false)}></button>
      <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300">
        <div class="flex items-center h-14 px-4 border-b border-base-300">
          <span class="font-semibold text-sm">{siteName}</span>
          <button onclick={() => (mobileOpen = false)} class="btn btn-ghost btn-xs ml-auto"><X size={16} /></button>
        </div>
        <nav class="flex-1 overflow-y-auto py-3">
          {#each navPages as p}
            {@const href = `${base}/portal-client/${p.slug}`}
            <div class="px-2 py-0.5">
              <a href={href} onclick={() => (mobileOpen = false)}
                class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors
                  {isActive(href) ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}">
                {#if p.icon}<span class="text-base leading-none shrink-0">{p.icon}</span>{/if}
                <span class="truncate">{p.title}</span>
              </a>
            </div>
          {/each}
        </nav>
      </aside>
    {/if}

    <!-- ─── Main ────────────────────────────────────────────── -->
    <div class="flex-1 flex flex-col min-w-0">
      <header class="lg:hidden flex items-center gap-3 px-4 h-14 border-b border-base-300 bg-base-100 shrink-0">
        <button onclick={() => (mobileOpen = true)} class="btn btn-ghost btn-sm"><Menu size={18} /></button>
        <span class="font-semibold text-sm">{siteName}</span>
        <button onclick={() => (dark = !dark)} class="btn btn-ghost btn-sm ml-auto">
          {#if dark}<Sun size={16} />{:else}<Moon size={16} />{/if}
        </button>
      </header>
      <main class="flex-1 overflow-y-auto p-6">
        {@render children()}
      </main>
    </div>
  </div>
{/if}

<ToastContainer />
