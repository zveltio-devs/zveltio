<script lang="ts">
  /**
   * Mobile sidebar drawer.
   *
   * Same nav model as the desktop sidebar; rendered as a slide-in over an
   * opaque backdrop. Closes on backdrop click, item click, or the X button.
   *
   * Previously the drawer omitted the auto-injected Extensions group — fixed
   * here for parity with the desktop sidebar.
   */
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { Puzzle, X } from '@lucide/svelte';
  import type { NavGroup, NavItem } from './Sidebar.svelte';

  interface Props {
    open: boolean;
    nav: NavGroup[];
    allExtNav: NavItem[];
    onClose: () => void;
  }

  let { open, nav, allExtNav, onClose }: Props = $props();

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    if (href === `${base}/`) return cur === `${base}/` || cur === `${base}`;
    return cur.startsWith(href);
  }
</script>

{#if open}
  <button
    class="fixed inset-0 z-40 bg-black/50 lg:hidden cursor-default"
    aria-label="Close menu"
    onclick={onClose}
  ></button>

  <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300 lg:hidden">
    <div class="flex items-center h-14 px-3 gap-2 shadow-z1">
      <div class="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center
                  bg-linear-to-br from-primary to-secondary shadow-z1">
        <span class="text-primary-content font-bold text-sm">Z</span>
      </div>
      <span class="font-semibold text-sm tracking-tight text-base-content">Zveltio</span>
      <button onclick={onClose} aria-label="Close menu" class="btn btn-ghost btn-xs ml-auto">
        <X size={16} />
      </button>
    </div>

    <nav class="flex-1 overflow-y-auto py-2" aria-label="Primary">
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
              onclick={onClose}
              aria-current={active ? 'page' : undefined}
              class="
                flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
                transition-colors duration-100
                focus-visible:outline-2 focus-visible:outline-primary
                {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
              "
            >
              <item.icon size={16} class="shrink-0" />
              <span class="truncate leading-none">{item.label}</span>
            </a>
          </div>
        {/each}
      {/each}

      {#if allExtNav.length > 0}
        <div class="px-4 pt-5 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-widest text-base-content/30 flex items-center gap-1 select-none">
            <Puzzle size={10} /> Extensions
          </span>
        </div>
        {#each allExtNav as item}
          {@const active = isActive(item.href)}
          <div class="px-2 py-0.5">
            <a
              href={item.href}
              onclick={onClose}
              aria-current={active ? 'page' : undefined}
              class="
                flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium
                transition-colors duration-100
                focus-visible:outline-2 focus-visible:outline-primary
                {active ? 'bg-primary/10 text-primary' : 'text-base-content/60 hover:bg-base-300 hover:text-base-content'}
              "
            >
              <item.icon size={16} class="shrink-0" />
              <span class="truncate leading-none">{item.label}</span>
            </a>
          </div>
        {/each}
      {/if}
    </nav>
  </aside>
{/if}
