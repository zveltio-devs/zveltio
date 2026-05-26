<script lang="ts">
/**
 * Standard CRUD-list page shell.
 *
 * The pattern: PageHeader → search → loading/empty/list → pagination.
 * Wraps the recurring layout used by Collections, Webhooks, Flows,
 * Users, API Keys, etc. so:
 *
 *   - Empty states are visually consistent (always via `EmptyState`).
 *   - Loading states use the same spinner.
 *   - Search bar only shows once the list grows past a threshold.
 *   - The primary action sits in the same spot every time.
 *
 * Pages that need richer layouts (tabs, side panels, drill-down) keep
 * rolling their own — this is for the 80% case.
 */
import type { Component, Snippet } from 'svelte';
import { LoaderCircle, Plus } from '@lucide/svelte';
import PageHeader from './PageHeader.svelte';
import EmptyState from './EmptyState.svelte';
import SearchBar from './SearchBar.svelte';
import { m } from '$lib/i18n.svelte.js';

type IllustrationVariant = 'list' | 'table' | 'cloud' | 'target' | 'spark';

interface EmptyConfig {
  icon?: Component<any>;
  illustration?: IllustrationVariant;
  illustrationColor?: string;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}

interface Props {
  title: string;
  subtitle?: string;
  count?: number | null;
  loading?: boolean;
  /** When provided, renders the SearchBar above the list. */
  search?: string;
  onSearchChange?: (v: string) => void;
  searchPlaceholder?: string;
  /** Hide the SearchBar until count exceeds this threshold. Default 4. */
  searchThreshold?: number;
  /** Primary action button in the header. */
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  actionIcon?: Component<any>;
  empty?: EmptyConfig;
  /** Custom slot to override the "no match" message when search is active. */
  noSearchMatch?: Snippet<[string]>;
  /** Render after the header but before the search bar. */
  headerExtras?: Snippet;
  /** The list/table itself — only shown when loading=false and count>0. */
  list: Snippet;
  /** Optional pagination block below the list. */
  pagination?: Snippet;
}

let {
  title,
  subtitle,
  count,
  loading = false,
  search,
  onSearchChange,
  searchPlaceholder,
  searchThreshold = 4,
  actionLabel,
  actionHref,
  onAction,
  actionIcon,
  empty,
  noSearchMatch,
  headerExtras,
  list,
  pagination,
}: Props = $props();

const showSearch = $derived(onSearchChange !== undefined && (count ?? 0) > searchThreshold);
const isEmpty = $derived(!loading && (count ?? 0) === 0);
const hasSearchNoMatch = $derived(!loading && (count ?? 0) > 0 && (search ?? '').length > 0);
</script>

<!--
  Action-button icon: inline both branches so rolldown can never lose
  `Plus`. Previous attempts (`actionIcon: ActionIcon = Plus`, then
  `const ActionIcon = $derived(actionIcon ?? Plus)`) both failed at
  runtime with "Plus is not defined" — the bundler placed the icon
  import in a sibling chunk that the action-button code path didn't
  pull in. Splitting the if/else into two concrete branches forces
  `<Plus>` to appear as a real template tag in this module's chunk.
-->
<div class="space-y-4">
  <PageHeader {title} {subtitle} {count}>
    {#if actionLabel && actionHref}
      <a href={actionHref} class="btn btn-primary btn-sm gap-2">
        {#if actionIcon}
          {@const Icon = actionIcon}
          <Icon size={16} />
        {:else}
          <Plus size={16} />
        {/if}
        {actionLabel}
      </a>
    {:else if actionLabel && onAction}
      <button class="btn btn-primary btn-sm gap-2" onclick={onAction}>
        {#if actionIcon}
          {@const Icon = actionIcon}
          <Icon size={16} />
        {:else}
          <Plus size={16} />
        {/if}
        {actionLabel}
      </button>
    {/if}
  </PageHeader>

  {#if headerExtras}{@render headerExtras()}{/if}

  {#if showSearch && onSearchChange}
    <SearchBar value={search ?? ''} onchange={onSearchChange} placeholder={searchPlaceholder ?? m['common.search']()} />
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={28} class="animate-spin text-primary" />
    </div>
  {:else if isEmpty && empty}
    <EmptyState
      icon={empty.icon}
      illustration={empty.illustration}
      illustrationColor={empty.illustrationColor}
      title={empty.title}
      description={empty.description}
      actionLabel={empty.actionLabel}
      actionHref={empty.actionHref}
      onaction={empty.onAction}
    />
  {:else}
    {@render list()}

    {#if hasSearchNoMatch && search !== undefined}
      {#if noSearchMatch}
        {@render noSearchMatch(search)}
      {/if}
    {/if}

    {#if pagination}{@render pagination()}{/if}
  {/if}
</div>
