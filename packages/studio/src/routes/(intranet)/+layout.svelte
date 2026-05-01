<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import {
    LogOut, Sun, Moon, Menu, X, ShieldCheck, Home, Bell, SquareCheck, User as UserIcon,
  } from '@lucide/svelte';
  import ToastContainer from '$lib/components/common/ToastContainer.svelte';

  type NavPage = { slug: string; title: string; icon: string | null; children?: NavPage[]; is_homepage?: boolean };

  let { children } = $props();
  let mobileOpen = $state(false);
  let dark = $state(false);

  const ZONE_SLUG = 'intranet';
  let zone = $state<{ name: string; primary_color: string; site_name: string | null } | null>(null);
  let navPages = $state<NavPage[]>([]);

  /** Built-in routes shipped with Studio. These exist as real SvelteKit routes
   *  (no zone-page configuration required) and are always present in the nav. */
  const builtIns = $derived([
    { href: `${base}/intranet`,               title: 'Home',         Icon: Home,        external: false },
    { href: `${base}/intranet/tasks`,         title: 'Tasks',        Icon: SquareCheck, external: false },
    { href: `${base}/intranet/notifications`, title: 'Notifications', Icon: Bell,       external: false },
    { href: `${base}/intranet/profile`,       title: 'Profile',      Icon: UserIcon,    external: false },
  ]);

  $effect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-theme', dark ? 'dark' : 'light');
  });

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    if (href === `${base}/intranet`) return cur === `${base}/intranet`;
    return cur === href || cur.startsWith(href + '/');
  }

  onMount(async () => {
    const t = localStorage.getItem('zveltio-theme');
    if (t) dark = t === 'dark';

    await auth.init();
    if (!auth.isAuthenticated) {
      goto(`${base}/login`);
      return;
    }

    try {
      const res = await api.get<{ zone: any; nav: NavPage[] }>(`/api/zones/${ZONE_SLUG}/render`);
      zone = res.zone;
      // Filter out the homepage entry — the user clicks the title/logo to get
      // there, so showing "Home" twice (once built-in, once from zone) is noise.
      navPages = (res.nav ?? []).filter((p) => !p.is_homepage);
    } catch {
      // Zone not configured / forbidden — built-in nav still works.
      navPages = [];
    }
  });

  const siteName = $derived(zone?.site_name ?? zone?.name ?? 'Intranet');

  async function signOut() {
    await auth.signOut();
    goto(`${base}/login`);
  }

  /** Recursively flatten zone pages so the sidebar can render arbitrary tree
   *  depth without needing a separate component. Indentation is handled by
   *  passing a `depth` to the row renderer. */
  function flatten(pages: NavPage[], depth = 0): Array<{ depth: number; p: NavPage }> {
    const out: Array<{ depth: number; p: NavPage }> = [];
    for (const p of pages) {
      out.push({ depth, p });
      if (p.children?.length) out.push(...flatten(p.children, depth + 1));
    }
    return out;
  }
</script>

{#if auth.loading}
  <div class="flex h-screen items-center justify-center bg-base-100">
    <span class="loading loading-spinner loading-lg text-primary"></span>
  </div>

{:else if auth.isAuthenticated}
  <div class="flex h-screen bg-base-100 overflow-hidden">

    <!-- ─── Sidebar ───────────────────────────────────────── -->
    <aside class="hidden lg:flex flex-col w-64 shrink-0 bg-base-200 border-r border-base-300">

      <!-- Header -->
      <div class="flex items-center h-14 px-4 border-b border-base-300 gap-3">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style="background: {zone?.primary_color ? zone.primary_color : 'linear-gradient(135deg, #6366f1, #8b5cf6)'}">
          <span class="text-white font-bold text-sm leading-none">
            {siteName[0]?.toUpperCase() ?? 'I'}
          </span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm leading-none text-base-content truncate">{siteName}</p>
          <p class="text-[11px] text-base-content/45 mt-0.5">Employee Portal</p>
        </div>
      </div>

      <!-- Nav — built-in routes always present, zone pages added below -->
      <nav class="flex-1 overflow-y-auto py-3 space-y-0.5">

        <!-- Built-in routes -->
        <div class="px-3 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 select-none">
            Workspace
          </span>
        </div>
        {#each builtIns as b}
          {@const active = isActive(b.href)}
          <div class="px-2 py-0.5">
            <a
              href={b.href}
              class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
                transition-colors duration-100
                {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}"
            >
              <b.Icon size={16} class="shrink-0" />
              <span class="truncate leading-none">{b.title}</span>
            </a>
          </div>
        {/each}

        <!-- Zone pages — admin-configured -->
        <div class="px-3 pb-1 pt-4">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 select-none">
            Pages
          </span>
        </div>
        {#if navPages.length > 0}
          {#each flatten(navPages) as { depth, p } (p.slug)}
            {@const href = `${base}/intranet/${p.slug}`}
            {@const active = isActive(href)}
            <div class="px-2 py-0.5" style="padding-left: {0.5 + depth * 1}rem">
              <a
                href={href}
                class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
                  transition-colors duration-100
                  {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}"
              >
                {#if p.icon}<span class="text-base leading-none shrink-0">{p.icon}</span>{/if}
                <span class="truncate leading-none">{p.title}</span>
              </a>
            </div>
          {/each}
        {:else}
          <div class="px-4 py-2 text-center">
            <p class="text-[11px] text-base-content/40 leading-snug">No custom pages yet.</p>
            <a href="{base}/zones/intranet" class="text-[11px] text-primary hover:underline mt-0.5 inline-block">Add pages →</a>
          </div>
        {/if}

        <!-- Admin link (for users who also have admin access) -->
        <div class="px-2 pt-4">
          <div class="px-2 pb-1">
            <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 select-none">Admin</span>
          </div>
          <a
            href="{base}/"
            class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
              text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors"
          >
            <ShieldCheck size={16} class="shrink-0" />
            <span class="leading-none">Admin Panel</span>
          </a>
        </div>
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
          <button onclick={signOut} title="Sign out" class="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content">
            <LogOut size={13} />
          </button>
        </div>
      </div>
    </aside>

    <!-- ─── Mobile overlay ─────────────────────────────────── -->
    {#if mobileOpen}
      <button class="fixed inset-0 z-40 bg-black/50 lg:hidden cursor-default" aria-label="Close menu" onclick={() => (mobileOpen = false)}></button>
      <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300 lg:hidden">
        <div class="flex items-center h-14 px-4 border-b border-base-300">
          <span class="font-semibold text-sm">{siteName}</span>
          <button onclick={() => (mobileOpen = false)} class="btn btn-ghost btn-xs ml-auto"><X size={16} /></button>
        </div>
        <nav class="flex-1 overflow-y-auto py-3 space-y-0.5">
          <!-- Built-ins -->
          {#each builtIns as b}
            <div class="px-2 py-0.5">
              <a href={b.href} onclick={() => (mobileOpen = false)}
                class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors
                  {isActive(b.href) ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}">
                <b.Icon size={16} class="shrink-0" />
                <span class="truncate">{b.title}</span>
              </a>
            </div>
          {/each}

          <!-- Zone pages -->
          {#if navPages.length > 0}
            <div class="border-t border-base-300 my-2"></div>
            {#each flatten(navPages) as { depth, p } (p.slug)}
              {@const href = `${base}/intranet/${p.slug}`}
              <div class="px-2 py-0.5" style="padding-left: {0.5 + depth * 1}rem">
                <a href={href} onclick={() => (mobileOpen = false)}
                  class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors
                    {isActive(href) ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}">
                  {#if p.icon}<span class="text-base leading-none shrink-0">{p.icon}</span>{/if}
                  <span class="truncate">{p.title}</span>
                </a>
              </div>
            {/each}
          {/if}
        </nav>
      </aside>
    {/if}

    <!-- ─── Main content ───────────────────────────────────── -->
    <div class="flex-1 flex flex-col min-w-0">
      <header class="lg:hidden flex items-center gap-3 px-4 h-14 border-b border-base-300 bg-base-100 shrink-0">
        <button onclick={() => (mobileOpen = true)} class="btn btn-ghost btn-sm"><Menu size={18} /></button>
        <span class="font-semibold text-sm">Intranet</span>
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
