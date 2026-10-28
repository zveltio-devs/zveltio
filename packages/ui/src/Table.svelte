<script lang="ts" module>
export interface Column {
  key: string;
  label: string;
  /** Present when the column can order the rows: the URL that does it. */
  sortHref?: string;
}
</script>

<script lang="ts" generics="Row extends Record<string, unknown>">
/**
 * A data table (`@zveltio/ui`, ADR 0007). Sorting is a link per column, so the
 * sorted page is a URL the host loads and the back button works; `aria-sort`
 * tells assistive tech which column orders the rows. The kit has no catalogue:
 * every word comes from the host.
 */
import type { Snippet } from 'svelte';

let {
  columns,
  rows,
  rowKey,
  sort = null,
  cell,
  empty,
}: {
  columns: Column[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** The column the rows are ordered by now. */
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  /** Draws one cell; without it the value is shown as text. */
  cell?: Snippet<[Row, Column, number]>;
  /** Shown in place of the rows when there are none. */
  empty: string;
} = $props();

const ariaSort = (key: string) =>
  sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
</script>

<div class="overflow-x-auto bg-base-100 rounded-box shadow">
  <table class="table table-sm">
    <thead>
      <tr>
        {#each columns as c (c.key)}
          <th aria-sort={ariaSort(c.key)}>
            {#if c.sortHref}
              <a class="link link-hover inline-flex items-center gap-1" href={c.sortHref}>
                {c.label}
                {#if sort?.key === c.key}<span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span>{/if}
              </a>
            {:else}
              {c.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as r (rowKey(r))}
        <tr class="hover:bg-base-200">
          {#each columns as c, i (c.key)}
            <td>
              {#if cell}{@render cell(r, c, i)}{:else}{String(r[c.key] ?? '')}{/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr><td colspan={columns.length || 1} class="text-center text-base-content/60 py-8">{empty}</td></tr>
      {/each}
    </tbody>
  </table>
</div>
