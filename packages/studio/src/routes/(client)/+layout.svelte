<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import {
    LogOut, Sun, Moon, Menu, X, Bell,
    LayoutDashboard, FileCheck, Search, MapPin, MessageSquare,
    Ticket, FileText, User, ChevronRight,
  } from '@lucide/svelte';
  import ToastContainer from '$lib/components/common/ToastContainer.svelte';

  let { children } = $props();
  let mobileOpen = $state(false);
  let dark = $state(false);
  let portalConfig = $state<any>({ template: 'generic', site_name: 'Client Portal', primary_color: '#069494' });

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
      const res = await api.get<{ config: any }>('/api/portal-client/config');
      if (res.config) portalConfig = res.config;
    } catch { /* use defaults */ }
  });

  // Nav items per template — resolved after config loads
  const genericNav = [
    { href: `${base}/portal-client/dashboard`, icon: LayoutDashboard, label: 'Dashboard' },
    { href: `${base}/portal-client/tickets`,   icon: Ticket,          label: 'Support'   },
    { href: `${base}/portal-client/profile`,   icon: User,            label: 'Profile'   },
  ];

  const regulatoryNav = [
    { href: `${base}/portal-client/dashboard`,                   icon: LayoutDashboard, label: 'Overview'          },
    { href: `${base}/portal-client/regulatory/authorizations`,   icon: FileCheck,       label: 'Authorizations'    },
    { href: `${base}/portal-client/regulatory/inspections`,      icon: Search,          label: 'Inspections'       },
    { href: `${base}/portal-client/regulatory/locations`,        icon: MapPin,          label: 'Business Locations'},
    { href: `${base}/portal-client/regulatory/requests`,         icon: MessageSquare,   label: 'Requests'          },
    { href: `${base}/portal-client/tickets`,                     icon: Ticket,          label: 'Support'           },
    { href: `${base}/portal-client/profile`,                     icon: User,            label: 'Profile'           },
  ];

  const saasNav = [
    { href: `${base}/portal-client/dashboard`, icon: LayoutDashboard, label: 'Dashboard'    },
    { href: `${base}/portal-client/tickets`,   icon: Ticket,          label: 'Support'      },
    { href: `${base}/portal-client/profile`,   icon: User,            label: 'Account'      },
  ];

  const servicesNav = [
    { href: `${base}/portal-client/dashboard`, icon: LayoutDashboard, label: 'Dashboard' },
    { href: `${base}/portal-client/tickets`,   icon: MessageSquare,   label: 'Messages'  },
    { href: `${base}/portal-client/profile`,   icon: User,            label: 'Profile'   },
  ];

  const navItems = $derived(
    portalConfig.template === 'regulatory' ? regulatoryNav :
    portalConfig.template === 'saas'       ? saasNav       :
    portalConfig.template === 'services'   ? servicesNav   :
    genericNav
  );

  async function signOut() {
    await auth.signOut();
    goto(`${base}/portal-client/login`);
  }
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
          style="background-color: {portalConfig.primary_color ?? '#069494'}">
          <span class="text-white font-bold text-sm leading-none">
            {portalConfig.site_name?.[0]?.toUpperCase() ?? 'P'}
          </span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm leading-none text-base-content truncate">
            {portalConfig.site_name ?? 'Client Portal'}
          </p>
          <p class="text-[11px] text-base-content/45 mt-0.5 capitalize">
            {portalConfig.template ?? 'generic'} portal
          </p>
        </div>
      </div>

      <!-- Nav -->
      <nav class="flex-1 overflow-y-auto py-3">
        <div class="px-3 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 select-none">
            Navigation
          </span>
        </div>
        {#each navItems as item}
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
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="fixed inset-0 z-40 bg-black/50 lg:hidden" onclick={() => (mobileOpen = false)}></div>
      <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300">
        <div class="flex items-center h-14 px-4 border-b border-base-300">
          <span class="font-semibold text-sm">{portalConfig.site_name ?? 'Portal'}</span>
          <button onclick={() => (mobileOpen = false)} class="btn btn-ghost btn-xs ml-auto"><X size={16} /></button>
        </div>
        <nav class="flex-1 overflow-y-auto py-3">
          {#each navItems as item}
            <div class="px-2 py-0.5">
              <a href={item.href} onclick={() => (mobileOpen = false)}
                class="flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors
                  {isActive(item.href) ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}">
                <item.icon size={16} class="shrink-0" />
                <span class="truncate">{item.label}</span>
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
        <span class="font-semibold text-sm">{portalConfig.site_name ?? 'Portal'}</span>
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
