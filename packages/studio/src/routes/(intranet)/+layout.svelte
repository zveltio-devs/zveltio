<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import {
    LayoutDashboard, Database, CheckSquare, Bell, Settings,
    LogOut, Sun, Moon, Menu, X, ShieldCheck, User,
  } from '@lucide/svelte';
  import ToastContainer from '$lib/components/common/ToastContainer.svelte';

  let { children } = $props();
  let mobileOpen = $state(false);
  let dark = $state(false);

  $effect(() => {
    const theme = dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-theme', theme);
  });

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    if (href === `${base}/intranet`) return cur === `${base}/intranet`;
    return cur.startsWith(href);
  }

  onMount(async () => {
    const t = localStorage.getItem('zveltio-theme');
    if (t) dark = t === 'dark';

    await auth.init();
    if (!auth.isAuthenticated) {
      goto(`${base}/login`);
      return;
    }
  });

  const nav = [
    { href: `${base}/intranet`,              icon: LayoutDashboard, label: 'My Dashboard'  },
    { href: `${base}/intranet/collections`,  icon: Database,        label: 'Data'          },
    { href: `${base}/intranet/tasks`,        icon: CheckSquare,     label: 'My Tasks'      },
    { href: `${base}/intranet/notifications`,icon: Bell,            label: 'Notifications' },
    { href: `${base}/intranet/profile`,      icon: User,            label: 'My Profile'    },
  ];

  async function signOut() {
    await auth.signOut();
    goto(`${base}/login`);
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
        <div class="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <span class="text-primary-content font-bold text-sm">Z</span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm leading-none text-base-content">Intranet</p>
          <p class="text-[11px] text-base-content/45 mt-0.5">Employee Portal</p>
        </div>
      </div>

      <!-- Nav -->
      <nav class="flex-1 overflow-y-auto py-3 space-y-0.5">
        <div class="px-3 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 select-none">
            Navigation
          </span>
        </div>

        {#each nav as item}
          {@const active = isActive(item.href)}
          <div class="px-2 py-0.5">
            <a
              href={item.href}
              class="
                flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
                transition-colors duration-100
                {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
              "
            >
              <item.icon size={16} class="shrink-0" />
              <span class="truncate leading-none">{item.label}</span>
            </a>
          </div>
        {/each}

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
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="fixed inset-0 z-40 bg-black/50 lg:hidden" onclick={() => (mobileOpen = false)}></div>
      <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300 lg:hidden">
        <div class="flex items-center h-14 px-4 border-b border-base-300">
          <span class="font-semibold text-sm">Intranet</span>
          <button onclick={() => (mobileOpen = false)} class="btn btn-ghost btn-xs ml-auto"><X size={16} /></button>
        </div>
        <nav class="flex-1 overflow-y-auto py-3 space-y-0.5">
          {#each nav as item}
            <div class="px-2 py-0.5">
              <a href={item.href} onclick={() => (mobileOpen = false)}
                class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
                  transition-colors {isActive(item.href) ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}">
                <item.icon size={16} class="shrink-0" />
                <span class="truncate">{item.label}</span>
              </a>
            </div>
          {/each}
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
