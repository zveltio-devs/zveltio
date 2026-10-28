<script lang="ts">
/**
 * Tabs (`@zveltio/ui`). Arrow-key movement between tabs, `role="tablist"`,
 * `aria-selected` and the tab–panel wiring are `bits-ui`'s; daisyUI's `tabs`
 * styles the active tab from `aria-selected`.
 */
import { Tabs } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  tabs,
  value = $bindable(tabs[0]?.value ?? ''),
  panel,
  label,
}: {
  tabs: Array<{ value: string; label: string; disabled?: boolean }>;
  value?: string;
  /** Renders the active tab's panel, given its value. */
  panel: Snippet<[string]>;
  /** The tab list's accessible name. */
  label: string;
} = $props();
</script>

<Tabs.Root bind:value>
  <Tabs.List class="tabs tabs-border" aria-label={label}>
    {#each tabs as t (t.value)}
      <Tabs.Trigger value={t.value} disabled={t.disabled} class="tab">{t.label}</Tabs.Trigger>
    {/each}
  </Tabs.List>
  {#each tabs as t (t.value)}
    <!-- Only the active panel renders: a hidden panel would still mount and fetch. -->
    <Tabs.Content value={t.value} class="pt-4">
      {#if value === t.value}{@render panel(t.value)}{/if}
    </Tabs.Content>
  {/each}
</Tabs.Root>
