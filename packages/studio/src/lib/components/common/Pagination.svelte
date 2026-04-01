<script lang="ts">
  interface Props {
    total: number;
    page: number;
    limit: number;
    onchange: (page: number) => void;
  }
  let { total, page, limit, onchange }: Props = $props();
  const totalPages = $derived(Math.ceil(total / limit));
  const from = $derived((page - 1) * limit + 1);
  const to = $derived(Math.min(page * limit, total));
</script>

{#if totalPages > 1}
  <div class="flex items-center justify-between mt-4 text-sm">
    <span class="text-base-content/50 text-xs">{from}–{to} of {total.toLocaleString()}</span>
    <div class="join">
      <button class="join-item btn btn-xs" disabled={page === 1} onclick={() => onchange(page - 1)}>«</button>
      {#each Array.from({length: Math.min(totalPages, 7)}, (_, i) => {
        if (totalPages <= 7) return i + 1;
        if (i === 0) return 1;
        if (i === 6) return totalPages;
        if (page <= 4) return i + 1;
        if (page >= totalPages - 3) return totalPages - 6 + i;
        return page - 3 + i;
      }) as p}
        <button class="join-item btn btn-xs {p === page ? 'btn-primary' : ''}"
                onclick={() => onchange(p)}>{p}</button>
      {/each}
      <button class="join-item btn btn-xs" disabled={page === totalPages} onclick={() => onchange(page + 1)}>»</button>
    </div>
  </div>
{/if}
