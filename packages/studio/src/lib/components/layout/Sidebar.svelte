<script lang="ts">
  /**
   * Desktop sidebar.
   *
   * Renders the grouped nav model, the optional "Extensions" auto-injected
   * group, the sidebar.bottom slot for extensions, and the footer (intranet
   * link, dark-mode toggle, user identity + sign-out).
   *
   * The parent (`+layout.svelte`) owns auth state, the nav model, and
   * persistence of `collapsed` / `dark` in localStorage. This component is
   * pure presentation — it emits intent callbacks.
   */
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import Slot from '$lib/components/common/Slot.svelte';
  import {
    LogOut, Sun, Moon, PanelLeftClose, PanelLeftOpen, Users2, Puzzle, Rows3, Rows2,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';

  export type NavItem = { href: string; icon: Component; label: string; ext?: string };
  export type NavGroup = { label?: string; items: NavItem[] };

  interface Props {
    nav: NavGroup[];
    /** Auto-injected by the extension loader; rendered under an "Extensions" heading. */
    allExtNav: NavItem[];
    collapsed: boolean;
    dark: boolean;
    density: 'comfortable' | 'compact';
    user: { name?: string | null; email?: string | null } | null;
    onToggleCollapse: () => void;
    onToggleDark: () => void;
    onToggleDensity: () => void;
    onSignOut: () => void;
  }

  let {
    nav, allExtNav, collapsed, dark, density, user,
    onToggleCollapse, onToggleDark, onToggleDensity, onSignOut,
  }: Props = $props();

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    if (href === `${base}/`) return cur === `${base}/` || cur === `${base}`;
    return cur.startsWith(href);
  }
</script>

<aside class="
  hidden lg:flex flex-col shrink-0 bg-base-200/60 backdrop-blur-xl
  transition-all duration-200 ease-in-out shadow-z1
  {collapsed ? 'w-16' : 'w-64'}
">
  <!-- Logo + collapse toggle -->
  <div class="flex items-center h-14 px-3 shrink-0 gap-2">
    {#if collapsed}
      <div class="mx-auto w-8 h-8 rounded-xl shrink-0 flex items-center justify-center
                  bg-linear-to-br from-primary to-secondary shadow-z1">
        <span class="text-primary-content font-bold text-sm leading-none">Z</span>
      </div>
    {:else}
      <a href="{base}/" class="flex items-center gap-2.5 flex-1 min-w-0 focus-visible:outline-2 focus-visible:outline-primary rounded-lg">
        <div class="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center
                    bg-linear-to-br from-primary to-secondary shadow-z1">
          <span class="text-primary-content font-bold text-sm leading-none">Z</span>
        </div>
        <span class="font-semibold text-sm tracking-tight text-base-content truncate">Zveltio</span>
      </a>
    {/if}
    <button
      onclick={onToggleCollapse}
      class="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content shrink-0 {collapsed ? 'mx-auto' : ''}"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {#if collapsed}<PanelLeftOpen size={15} />{:else}<PanelLeftClose size={15} />{/if}
    </button>
  </div>

  <!-- Navigation -->
  <nav class="flex-1 overflow-y-auto overflow-x-hidden py-2" aria-label="Primary">
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
            aria-current={active ? 'page' : undefined}
            class="
              flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
              transition-colors duration-100
              focus-visible:outline-2 focus-visible:outline-primary
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

    <!-- Extension routes (manifest-driven) -->
    {#if allExtNav.length > 0}
      {#if !collapsed}
        <div class="px-4 pt-5 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 flex items-center gap-1 select-none">
            <Puzzle size={10} /> Extensions
          </span>
        </div>
      {:else}
        <div class="mx-3 my-2.5 h-px bg-base-content/8"></div>
      {/if}
      {#each allExtNav as item}
        {@const active = isActive(item.href)}
        <div class="px-2 py-0.5">
          <a
            href={item.href}
            title={collapsed ? item.label : undefined}
            aria-current={active ? 'page' : undefined}
            class="
              flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
              transition-colors duration-100
              focus-visible:outline-2 focus-visible:outline-primary
              {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
              {collapsed ? 'justify-center' : ''}
            "
          >
            <item.icon size={16} class="shrink-0" />
            {#if !collapsed}<span class="truncate leading-none">{item.label}</span>{/if}
          </a>
        </div>
      {/each}
    {/if}
  </nav>

  <!-- Extension slot — above the footer -->
  <div class="shrink-0 px-2 py-1">
    <Slot name="sidebar.bottom" ctx={{ user, collapsed }} />
  </div>

  <!-- Footer -->
  <div class="shrink-0 px-2 py-2 space-y-0.5 bg-base-200/40">
    <a
      href="{base}/intranet"
      title={collapsed ? 'Employee Intranet' : undefined}
      class="
        flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
        text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors
        focus-visible:outline-2 focus-visible:outline-primary
        {collapsed ? 'justify-center' : ''}
      "
    >
      <Users2 size={16} class="shrink-0" />
      {#if !collapsed}<span class="leading-none">Employee Intranet</span>{/if}
    </a>

    <button
      onclick={onToggleDark}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      class="
        w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
        text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors
        focus-visible:outline-2 focus-visible:outline-primary
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

    <button
      onclick={onToggleDensity}
      title={density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density'}
      aria-label={density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density'}
      aria-pressed={density === 'compact'}
      class="
        w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-[13px] font-medium
        text-base-content/60 hover:bg-base-300 hover:text-base-content transition-colors
        focus-visible:outline-2 focus-visible:outline-primary
        {collapsed ? 'justify-center' : ''}
      "
    >
      {#if density === 'compact'}
        <Rows3 size={16} class="shrink-0" />
        {#if !collapsed}<span class="leading-none">Comfortable</span>{/if}
      {:else}
        <Rows2 size={16} class="shrink-0" />
        {#if !collapsed}<span class="leading-none">Compact</span>{/if}
      {/if}
    </button>

    <div class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg {collapsed ? 'flex-col' : ''}">
      <a
        href="{base}/account"
        title="Account settings"
        class="
          flex items-center gap-2.5 flex-1 min-w-0 hover:bg-base-300 rounded-md
          focus-visible:outline-2 focus-visible:outline-primary
          {collapsed ? 'flex-col' : ''}
        "
      >
        <div class="
          shrink-0 rounded-full bg-primary text-primary-content
          flex items-center justify-center font-semibold
          {collapsed ? 'w-7 h-7 text-xs' : 'w-8 h-8 text-xs'}
        ">
          {user?.name?.charAt(0).toUpperCase() || 'U'}
        </div>
        {#if !collapsed}
          <div class="flex-1 min-w-0">
            <p class="text-[11px] font-medium leading-none truncate text-base-content">{user?.name || 'User'}</p>
            <p class="text-[11px] text-base-content/45 mt-0.5 truncate">{user?.email}</p>
          </div>
        {/if}
      </a>
      <button
        onclick={onSignOut}
        title="Sign out"
        aria-label="Sign out"
        class="btn btn-ghost btn-xs text-base-content/40 hover:text-base-content shrink-0"
      >
        <LogOut size={13} />
      </button>
    </div>
  </div>
</aside>
