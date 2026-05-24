<script lang="ts">
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { X } from '@lucide/svelte';
  import { m, i18n } from '$lib/i18n.svelte.js';
  import { navLabel } from '$lib/nav-i18n.js';
  import type { ExtensionNavGroup, ExtensionNavGroupId, NavGroup } from '$lib/nav-model.js';

  interface Props {
    open: boolean;
    nav: NavGroup[];
    extNavGroups: ExtensionNavGroup[];
    onClose: () => void;
  }

  let { open, nav, extNavGroups, onClose }: Props = $props();

  const extGroupLabels: Record<ExtensionNavGroupId, () => string> = {
    business: () => m['nav.group.business'](),
    finance: () => m['nav.group.finance'](),
    hr: () => m['nav.group.hr'](),
    operations: () => m['nav.group.operations'](),
    compliance: () => m['nav.group.compliance'](),
    content: () => m['nav.group.content'](),
    communications: () => m['nav.group.communications'](),
    developer: () => m['nav.group.developer'](),
    projects: () => m['nav.group.projects'](),
    other: () => m['nav.group.other'](),
  };

  const _locale = $derived(i18n.locale);
  const groupLabel = (id: ExtensionNavGroupId) => {
    void _locale;
    return extGroupLabels[id]();
  };

  const coreGroupLabel = (key: string | undefined) => {
    void _locale;
    return key ? navLabel(key) : undefined;
  };

  const coreItemLabel = (key: string) => {
    void _locale;
    return navLabel(key);
  };

  function isActive(href: string): boolean {
    const cur = page.url.pathname;
    if (href === `${base}/`) return cur === `${base}/` || cur === `${base}`;
    return cur.startsWith(href);
  }
</script>

{#if open}
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/50 lg:hidden cursor-default"
    aria-label={m['shell.openMenu']()}
    onclick={onClose}
  ></button>

  <aside class="fixed left-0 top-0 h-full w-64 z-50 flex flex-col bg-base-200 border-r border-base-300 lg:hidden">
    <div class="flex items-center h-14 px-3 gap-2 shadow-z1">
      <div class="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center
                  bg-linear-to-br from-primary to-secondary shadow-z1">
        <span class="text-primary-content font-bold text-sm">Z</span>
      </div>
      <span class="font-semibold text-sm tracking-tight text-base-content">Zveltio</span>
      <button type="button" onclick={onClose} aria-label={m['shell.openMenu']()} class="btn btn-ghost btn-xs ml-auto">
        <X size={16} />
      </button>
    </div>

    <nav class="flex-1 overflow-y-auto py-2" aria-label="Primary">
      {#each nav as group, gi}
        {#if group.labelKey}
          <div class="px-4 {gi > 0 ? 'pt-5' : 'pt-3'} pb-1">
            <span class="text-[9px] font-medium uppercase tracking-[.12em] text-base-content/25 select-none">
              {coreGroupLabel(group.labelKey)}
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
              <span class="truncate leading-none">{coreItemLabel(item.labelKey)}</span>
            </a>
          </div>
        {/each}
      {/each}

      {#each extNavGroups as group (group.id)}
        <div class="px-4 pt-5 pb-1">
          <span class="text-[9px] font-medium uppercase tracking-[.12em] text-base-content/25 select-none">
            {groupLabel(group.id)}
          </span>
        </div>
        {#each group.items as item (item.href)}
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
    </nav>
  </aside>
{/if}
