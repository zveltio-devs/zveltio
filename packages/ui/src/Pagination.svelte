<script lang="ts">
/**
 * Previous / next links (`@zveltio/ui`). `pages` is optional: when the total is
 * unknown, `hasNext` alone says whether another page follows. Hidden when there
 * is only one page.
 */
let {
  page,
  pages = null,
  hasNext,
  href,
  previousLabel,
  nextLabel,
}: {
  page: number;
  pages?: number | null;
  hasNext: boolean;
  href: (page: number) => string;
  previousLabel: string;
  nextLabel: string;
} = $props();
</script>

{#if page > 1 || hasNext}
  <nav class="join">
    {#if page > 1}
      <a class="join-item btn btn-sm" href={href(page - 1)} aria-label={previousLabel}>«</a>
    {:else}
      <span class="join-item btn btn-sm btn-disabled" aria-hidden="true">«</span>
    {/if}
    <span class="join-item btn btn-sm btn-ghost" aria-current="page">{page}{pages != null ? ` / ${pages}` : ''}</span>
    {#if hasNext}
      <a class="join-item btn btn-sm" href={href(page + 1)} aria-label={nextLabel}>»</a>
    {:else}
      <span class="join-item btn btn-sm btn-disabled" aria-hidden="true">»</span>
    {/if}
  </nav>
{/if}
