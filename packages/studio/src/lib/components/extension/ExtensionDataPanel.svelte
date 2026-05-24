<script lang="ts">
  /**
   * Loading / empty / table wrapper for extension list pages.
   */
  import type { Snippet } from 'svelte';
  import { LoaderCircle } from '@lucide/svelte';
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import { m } from '$lib/i18n.svelte.js';

  interface Props {
    loading?: boolean;
    empty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    table: Snippet;
  }

  let {
    loading = false,
    empty = false,
    emptyTitle,
    emptyDescription,
    table,
  }: Props = $props();
</script>

{#if loading}
  <div class="flex justify-center py-16" role="status" aria-live="polite">
    <LoaderCircle size={28} class="animate-spin text-primary" />
    <span class="sr-only">{m['common.loading']()}</span>
  </div>
{:else if empty}
  <EmptyState
    illustration="table"
    title={emptyTitle ?? m['common.noResults']()}
    description={emptyDescription ?? ''}
  />
{:else}
  <div class="overflow-x-auto rounded-xl border border-base-300/60 bg-base-100">
    {@render table()}
  </div>
{/if}
