<script lang="ts">
/** The state of a `readRows` load around the view that draws the records. */
import type { Snippet } from 'svelte';
import { m } from '#lib/i18n.svelte.js';
import type { Rows } from './rows.svelte.js';

interface Props {
  rows: Rows;
  /** Drawn with no records too (a calendar, a matrix's empty grid). */
  always?: boolean;
  children: Snippet;
}
const { rows, always = false, children }: Props = $props();
</script>

{#if rows.waiting}
  <p class="text-sm text-base-content/65 py-6 text-center">{m['view.selectFirst']()}</p>
{:else if rows.error}
  <div class="alert alert-error text-sm">{rows.error}</div>
{:else if rows.loading && rows.rows.length === 0}
  <span class="loading loading-spinner loading-sm"></span>
{:else if rows.rows.length === 0 && !always}
  <p class="text-sm text-base-content/65 py-6 text-center">{m['common.noResults']()}</p>
{:else}
  {#if rows.total > rows.rows.length}
    <p class="text-xs text-warning mb-2" data-testid="view-truncated">
      {m['view.truncated']({ shown: rows.rows.length, total: rows.total })}
    </p>
  {/if}
  {@render children()}
{/if}
