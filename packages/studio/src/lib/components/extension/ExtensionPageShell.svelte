<script lang="ts">
/**
 * Standard layout for extension admin pages synced into Studio.
 * Use with Paraglide (`m`) for all user-visible strings.
 */
import type { Component, Snippet } from 'svelte';
import PageHeader from '$lib/components/common/PageHeader.svelte';
import SearchBar from '$lib/components/common/SearchBar.svelte';
import ExtensionTabBar from './ExtensionTabBar.svelte';

export type ExtensionTab = {
  id: string;
  label: string;
  icon?: Component<any>;
};

interface Props {
  title: string;
  subtitle?: string;
  count?: number | null;
  tabs?: ExtensionTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  search?: string;
  onSearchChange?: (v: string) => void;
  searchPlaceholder?: string;
  /** Filters / toolbar row below tabs (e.g. status select). */
  headerExtras?: Snippet;
  /** Header actions (e.g. primary "New" button). */
  actions?: Snippet;
  children: Snippet;
}

let {
  title,
  subtitle,
  count,
  tabs,
  activeTab,
  onTabChange,
  search,
  onSearchChange,
  searchPlaceholder,
  headerExtras,
  actions,
  children,
}: Props = $props();
</script>

<div class="space-y-4">
  <PageHeader {title} {subtitle} {count}>
    {#if actions}
      {@render actions()}
    {/if}
  </PageHeader>

  {#if tabs && tabs.length > 0 && activeTab && onTabChange}
    <ExtensionTabBar {tabs} activeId={activeTab} onchange={onTabChange} />
  {/if}

  {#if headerExtras}
    {@render headerExtras()}
  {/if}
  {#if onSearchChange !== undefined}
    <SearchBar
      value={search ?? ''}
      placeholder={searchPlaceholder}
      onchange={onSearchChange}
    />
  {/if}

  {@render children()}
</div>
