<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { auth } from '$lib/auth.svelte.js';
  import { initExtensions, extensions } from '$lib/extensions.svelte.js';
  import { extensionRegistry } from '$lib/extension-registry.svelte.js';
  import {
    LayoutDashboard, Database, Users, Shield, Webhook, Settings,
    Puzzle, LogOut, HardDrive, Key, ClipboardList, Languages,
    Upload, Bot, Bell, Download, Workflow, Package, GitBranch, Plug,
    Wand2, Building2, Images, DatabaseBackup, Layout, CheckSquare,
    ScanSearch, Search, Code, Bookmark, BarChart2, Terminal, Activity,
    LayoutGrid, Sun, Moon, PanelLeftClose, PanelLeftOpen, Users2, Menu, X,
  } from '@lucide/svelte';
  import ToastContainer from '$lib/components/common/ToastContainer.svelte';
  import UpdateBanner from '$lib/components/common/UpdateBanner.svelte';
  import CommandPalette from '$lib/components/common/CommandPalette.svelte';

  let { children } = $props();
  let collapsed = $state(false);
  let mobileOpen = $state(false);
  let dark = $state(false);
  let cmdOpen = $state(false);

  $effect(() => {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-sidebar', String(collapsed));
  });

  $effect(() => {
    const theme = dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('zveltio-theme', theme);
  });

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    if (href === `${base}/`) return cur === `${base}/` || cur === `${base}`;
    return cur.startsWith(href);
  }

  onMount(async () => {
    const sc = localStorage.getItem('zveltio-sidebar');
    if (sc !== null) collapsed = sc === 'true';
    const t = localStorage.getItem('zveltio-theme');
    if (t) dark = t === 'dark';

    await auth.init();
    if (!auth.isAuthenticated) { goto(`${base}/login`); return; }
    await initExtensions();
  });

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        cmdOpen = !cmdOpen;
      }
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  type NavItem = { href: string; icon: any; label: string };
  type NavGroup = { label?: string; items: NavItem[] };

  // Bundled extension nav items — shown only when the extension is enabled in the DB
  const bundledExtNav = $derived<NavItem[]>(
    extensions.initialized ? [
      ...(extensions.isActive('workflow/checklists')
        ? [{ href: `${base}/extensions/checklists`, icon: CheckSquare, label: 'Checklists' }]
        : []),
      ...(extensions.isActive('content/page-builder')
        ? [{ href: `${base}/extensions/page-builder`, icon: Layout,      label: 'Pages'      }]
        : []),
    ] : [],
  );

  const nav: NavGroup[] = [
    {
      items: [
        { href: `${base}/`, icon: LayoutDashboard, label: 'Dashboard' },
      ]
    },
    {
      label: 'Content & Data',
      items: [
        { href: `${base}/collections`, icon: Database,    label: 'Collections' },
        { href: `${base}/views`,       icon: Layout,      label: 'Views'       },
        { href: `${base}/media`,       icon: Images,      label: 'Media'       },
      ]
    },
    {
      label: 'Portals & Zones',
      items: [
        { href: `${base}/zones`,       icon: LayoutGrid,  label: 'Zones'       },
      ]
    },
    {
      label: 'Users & Access',
      items: [
        { href: `${base}/users`,       icon: Users,    label: 'Users'       },
        { href: `${base}/permissions`, icon: Shield,   label: 'Permissions' },
        { href: `${base}/rls`,         icon: Shield,   label: 'Row Security' },
        { href: `${base}/api-keys`,    icon: Key,      label: 'API Keys'    },
        { href: `${base}/tenants`,     icon: Building2, label: 'Tenants'   },
      ]
    },
    {
      label: 'Automation',
      items: [
        { href: `${base}/flows`,         icon: Workflow,    label: 'Flows'         },
        { href: `${base}/webhooks`,      icon: Webhook,     label: 'Webhooks'      },
        { href: `${base}/notifications`, icon: Bell,        label: 'Notifications' },
        { href: `${base}/approvals`,     icon: CheckSquare, label: 'Approvals'     },
      ]
    },
    {
      label: 'Intelligence',
      items: [
        { href: `${base}/ai`,               icon: Bot,         label: 'AI Hub'       },
        { href: `${base}/insights`,         icon: BarChart2,   label: 'Insights'     },
      ]
    },
    {
      label: 'Developer',
      items: [
        { href: `${base}/edge-functions`,      icon: Code,       label: 'Edge Functions'    },
        { href: `${base}/schema-branches`,     icon: GitBranch,  label: 'Schema Branches'   },
        { href: `${base}/virtual-collections`, icon: Plug,       label: 'Virtual Collections' },
        { href: `${base}/saved-queries`,       icon: Bookmark,   label: 'Saved Queries'     },
        { href: `${base}/sql`,                 icon: Terminal,   label: 'SQL Editor'        },
        { href: `${base}/introspect`,          icon: ScanSearch, label: 'BYOD Import'       },
      ]
    },
    {
      label: 'Operations',
      items: [
        { href: `${base}/storage`,      icon: HardDrive,    label: 'Storage'    },
        { href: `${base}/backup`,       icon: DatabaseBackup, label: 'Backup'   },
        { href: `${base}/import`,       icon: Upload,       label: 'Import'     },
        { href: `${base}/export`,       icon: Download,     label: 'Export'     },
        { href: `${base}/request-logs`,   icon: Activity,      label: 'Request Logs' },
        { href: `${base}/audit`,        icon: ClipboardList, label: 'Audit Log' },
        { href: `${base}/translations`, icon: Languages,    label: 'Translations' },
        { href: `${base}/marketplace`,  icon: Package,      label: 'Marketplace' },
        { href: `${base}/settings`,     icon: Settings,     label: 'Settings'    },
      ]
    },
  ];

  async function signOut() {
    await auth.signOut();
    goto(`${base}/login`);
  }
</script>

{#if auth.loading}
  <div class="flex h-screen items-center justify-center bg-base-100">
    <div class="flex flex-col items-center gap-3">
      <span class="loading loading-spinner loading-lg text-primary"></span>
      <p class="text-sm text-base-content/50">Loading…</p>
    </div>
  </div>

{:else if auth.isAuthenticated}
  <div class="flex h-screen bg-base-100 overflow-hidden">

    <!-- ─── Sidebar (desktop) ──────────────────────────────── -->
    <aside class="
      hidden lg:flex flex-col shrink-0 bg-base-200 border-r border-base-300
      transition-all duration-200 ease-in-out
      {collapsed ? 'w-16' : 'w-64'}
    ">

      <!-- Logo + collapse toggle -->
      <div class="flex items-center h-14 px-3 border-b border-base-300 shrink-0 gap-2">
        {#if collapsed}
          <div class="mx-auto w-7 h-7 rounded-lg shrink-0 flex items-center justify-center"
               style="background: linear-gradient(135deg, #6366f1, #8b5cf6);">
            <span class="text-white font-bold text-sm leading-none">Z</span>
          </div>
        {:else}
          <a href="{base}/" class="flex items-center gap-2.5 flex-1 min-w-0">
            <div class="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center"
                 style="background: linear-gradient(135deg, #6366f1, #8b5cf6);">
              <span class="text-white font-bold text-sm leading-none">Z</span>
            </div>
            <span class="font-semibold text-sm tracking-tight text-base-content truncate">Zveltio</span>
          </a>
        {/if}
        <button
          onclick={() => (collapsed = !collapsed)}
          class="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content shrink-0
            {collapsed ? 'mx-auto' : ''}"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {#if collapsed}<PanelLeftOpen size={15} />{:else}<PanelLeftClose size={15} />{/if}
        </button>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {#each nav as group, gi}
          {#if group.label}
            {#if !collapsed}
              <div class="px-4 {gi > 0 ? 'pt-5' : 'pt-3'} pb-1">
                <span class="text-[9px] font-medium uppercase tracking-[.12em] text-base-content/25 select-none">
                  {group.label}
                </span>
              </div>
            {:else}
              <div class="mx-3 my-2.5 h-px bg-base-content/8"></div>
            {/if}
          {/if}

          {#each group.items as item}
            {@const active = isActive(item.href)}
            <div class="px-2 py-0.5">
              <a
                href={item.href}
                title={collapsed ? item.label : undefined}
                class="
                  flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
                  transition-colors duration-100 outline-none
                  {active
                    ? 'bg-primary/10 text-primary'
                    : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
                  {collapsed ? 'justify-center' : ''}
                "
              >
                <item.icon size={16} class="shrink-0" />
                {#if !collapsed}
                  <span class="truncate leading-none">{item.label}</span>
                {/if}
              </a>
            </div>
          {/each}
        {/each}

        <!-- Extension routes (bundled + IIFE) -->
        {#if bundledExtNav.length > 0 || (extensions.initialized && extensionRegistry.routes.length > 0)}
          {#if !collapsed}
            <div class="px-4 pt-5 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 flex items-center gap-1 select-none">
                <Puzzle size={10} /> Extensions
              </span>
            </div>
          {:else}
            <div class="mx-3 my-2.5 h-px bg-base-content/8"></div>
          {/if}
          {#each bundledExtNav as item}
            <div class="px-2 py-0.5">
              <a
                href={item.href}
                title={collapsed ? item.label : undefined}
                class="
                  flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
                  transition-colors duration-100
                  {isActive(item.href) ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
                  {collapsed ? 'justify-center' : ''}
                "
              >
                <item.icon size={16} class="shrink-0" />
                {#if !collapsed}<span class="truncate leading-none">{item.label}</span>{/if}
              </a>
            </div>
          {/each}
          {#each extensionRegistry.routes as route}
            <div class="px-2 py-0.5">
              <a
                href="{base}/extensions/{route.path}"
                title={collapsed ? route.label : undefined}
                class="
                  flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
                  transition-colors duration-100
                  {isActive(`${base}/extensions/${route.path}`)
                    ? 'bg-primary/10 text-primary'
                    : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
                  {collapsed ? 'justify-center' : ''}
                "
              >
                <Puzzle size={16} class="shrink-0" />
                {#if !collapsed}<span class="truncate leading-none">{route.label}</span>{/if}
              </a>
            </div>
          {/each}
        {/if}

      </nav>

      <!-- Footer -->
      <div class="shrink-0 border-t border-base-300 px-2 py-2 space-y-0.5">

        <!-- Intranet link -->
        <a
          href="{base}/intranet"
          title={collapsed ? 'Employee Intranet' : undefined}
          class="
            flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
            text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors
            {collapsed ? 'justify-center' : ''}
          "
        >
          <Users2 size={16} class="shrink-0" />
          {#if !collapsed}<span class="leading-none">Employee Intranet</span>{/if}
        </a>

        <!-- Dark mode toggle -->
        <button
          onclick={() => (dark = !dark)}
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          class="
            w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
            text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors
            {collapsed ? 'justify-center' : ''}
          "
        >
          {#if dark}
            <Sun size={16} class="shrink-0" />
            {#if !collapsed}<span class="leading-none">Light Mode</span>{/if}
          {:else}
            <Moon size={16} class="shrink-0" />
            {#if !collapsed}<span class="leading-none">Dark Mode</span>{/if}
          {/if}
        </button>

        <!-- User -->
        <div class="
          flex items-center gap-2.5 px-2.5 py-2 rounded-lg
          {collapsed ? 'flex-col' : ''}
        ">
          <div class="
            shrink-0 rounded-full bg-primary text-primary-content
            flex items-center justify-center font-semibold
            {collapsed ? 'w-7 h-7 text-xs' : 'w-8 h-8 text-xs'}
          " title={auth.user?.name}>
            {auth.user?.name?.charAt(0).toUpperCase() || 'U'}
          </div>
          {#if !collapsed}
            <div class="flex-1 min-w-0">
              <p class="text-[11px] font-medium leading-none truncate text-base-content">{auth.user?.name || 'User'}</p>
              <p class="text-[11px] text-base-content/45 mt-0.5 truncate">{auth.user?.email}</p>
            </div>
          {/if}
          <button
            onclick={signOut}
            title="Sign out"
            class="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content shrink-0"
          >
            <LogOut size={13} />
          </button>
        </div>
      </div>
    </aside>

    <!-- ─── Mobile overlay ──────────────────────────────────── -->
    {#if mobileOpen}
      <button
        class="fixed inset-0 z-40 bg-black/50 lg:hidden cursor-default"
        aria-label="Close menu"
        onclick={() => (mobileOpen = false)}
      ></button>

      <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300 lg:hidden">
        <div class="flex items-center h-14 px-3 border-b border-base-300 gap-2">
          <div class="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center"
               style="background: linear-gradient(135deg, #6366f1, #8b5cf6);">
            <span class="text-white font-bold text-sm">Z</span>
          </div>
          <span class="font-semibold text-sm tracking-tight text-base-content">Zveltio</span>
          <button onclick={() => (mobileOpen = false)} class="btn btn-ghost btn-xs ml-auto">
            <X size={16} />
          </button>
        </div>

        <nav class="flex-1 overflow-y-auto py-2">
          {#each nav as group, gi}
            {#if group.label}
              <div class="px-4 {gi > 0 ? 'pt-5' : 'pt-3'} pb-1">
                <span class="text-[9px] font-medium uppercase tracking-[.12em] text-base-content/25 select-none">
                  {group.label}
                </span>
              </div>
            {/if}
            {#each group.items as item}
              {@const active = isActive(item.href)}
              <div class="px-2 py-0.5">
                <a
                  href={item.href}
                  onclick={() => (mobileOpen = false)}
                  class="
                    flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
                    transition-colors duration-100
                    {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
                  "
                >
                  <item.icon size={16} class="shrink-0" />
                  <span class="truncate leading-none">{item.label}</span>
                </a>
              </div>
            {/each}
          {/each}
        </nav>
      </aside>
    {/if}

    <!-- ─── Main content ─────────────────────────────────────── -->
    <div class="flex-1 flex flex-col min-w-0">

      <!-- Mobile header -->
      <header class="lg:hidden flex items-center gap-3 px-4 h-14 border-b border-base-300 bg-base-100 shrink-0">
        <button onclick={() => (mobileOpen = true)} class="btn btn-ghost btn-sm">
          <Menu size={18} />
        </button>
        <div class="w-6 h-6 rounded-lg bg-primary flex items-center justify-center">
          <span class="text-primary-content font-bold text-xs">Z</span>
        </div>
        <span class="font-bold text-sm">Zveltio</span>
        <div class="ml-auto flex items-center gap-1">
          <button onclick={() => (cmdOpen = true)} class="btn btn-ghost btn-sm" title="Search (⌘K)">
            <Search size={16} />
          </button>
          <button onclick={() => (dark = !dark)} class="btn btn-ghost btn-sm">
            {#if dark}<Sun size={16} />{:else}<Moon size={16} />{/if}
          </button>
        </div>
      </header>

      <main class="flex-1 overflow-y-auto p-6">
        {@render children()}
      </main>
    </div>
  </div>
{/if}

<ToastContainer />
<UpdateBanner />
<CommandPalette open={cmdOpen} onclose={() => (cmdOpen = false)} />
