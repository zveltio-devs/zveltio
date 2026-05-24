<script lang="ts">
  import type { Component } from 'svelte';
  import type { ExtensionTab } from './ExtensionPageShell.svelte';

  interface Props {
    tabs: ExtensionTab[];
    activeId: string;
    onchange: (id: string) => void;
  }
  let { tabs, activeId, onchange }: Props = $props();
</script>

<div class="tabs tabs-boxed bg-base-200 w-fit" role="tablist">
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      role="tab"
      aria-selected={activeId === tab.id}
      class="tab gap-1.5 {activeId === tab.id ? 'tab-active' : ''}"
      onclick={() => onchange(tab.id)}
    >
      {#if tab.icon}
        <tab.icon size={13} aria-hidden="true" />
      {/if}
      {tab.label}
    </button>
  {/each}
</div>
