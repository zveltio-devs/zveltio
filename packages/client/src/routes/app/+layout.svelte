<script lang="ts">
import type { Snippet } from 'svelte';
import { Database, LayoutDashboard, LogOut, Menu, UserRound } from '@lucide/svelte';
import { page } from '$app/state';
import { useAuth } from '#lib/stores/auth.svelte.js';
import type { LayoutData } from './$types';

/**
 * The workspace shell (ADR 0006). The navigation is what the engine answered:
 * `GET /api/data` lists only the collections this user may read, so nothing
 * here decides who sees what.
 */
let { data, children }: { data: LayoutData; children: Snippet } = $props();
const auth = useAuth();
let drawerOpen = $state(false);
// The layout outlives navigation; on a narrow screen the drawer would stay open
// over the page a sidebar link just opened.
$effect(() => {
  page.url.pathname;
  drawerOpen = false;
});
</script>

<div class="drawer lg:drawer-open">
  <input id="sidebar" type="checkbox" class="drawer-toggle" bind:checked={drawerOpen} />

  <div class="drawer-content">
    <!-- Navbar -->
    <div class="navbar bg-base-100 shadow-sm lg:hidden">
      <label for="sidebar" class="btn btn-ghost btn-square">
        <Menu size={20} />
      </label>
      <span class="flex-1 text-lg font-semibold px-2">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </span>
    </div>

    <!-- Page content -->
    <main class="p-4 lg:p-8">
      {@render children()}
    </main>
  </div>

  <!-- Sidebar -->
  <div class="drawer-side z-40">
    <label for="sidebar" class="drawer-overlay"></label>
    <aside class="bg-base-200 w-64 min-h-full p-4 flex flex-col">
      <div class="text-xl font-bold mb-6 px-2">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </div>

      <ul class="menu flex-1 w-full">
        <li>
          <a href="/app" class="gap-2" class:menu-active={page.url.pathname === '/app'}>
            <LayoutDashboard size={18} />
            Dashboard
          </a>
        </li>
        {#if data.collections.length > 0}
          <li class="menu-title">Data</li>
          {#each data.collections as c (c.name)}
            <li>
              <a
                href="/app/data/{encodeURIComponent(c.name)}"
                class="gap-2"
                class:menu-active={page.url.pathname.startsWith(`/app/data/${encodeURIComponent(c.name)}`)}
              >
                <Database size={18} />
                {c.display_name ?? c.name}
              </a>
            </li>
          {/each}
        {/if}
      </ul>

      <!-- User footer -->
      <div class="border-t border-base-300 pt-4 mt-4">
        <div class="flex items-center gap-3 px-2 mb-3">
          <div class="avatar placeholder">
            <div class="bg-primary text-primary-content rounded-full w-8">
              <span class="text-xs">{data.user?.name?.[0] ?? '?'}</span>
            </div>
          </div>
          <div class="text-sm">
            <div class="font-medium">{data.user?.name}</div>
            <div class="text-base-content/65 text-xs">{data.user?.email}</div>
          </div>
        </div>
        <a href="/app/account" class="btn btn-ghost btn-sm w-full justify-start gap-2">
          <UserRound size={16} />
          Account
        </a>
        <button onclick={() => auth.signOut()} class="btn btn-ghost btn-sm w-full justify-start gap-2">
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  </div>
</div>
