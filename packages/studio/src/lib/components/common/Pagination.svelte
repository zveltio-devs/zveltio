<script lang="ts">
  let {
    currentPage = 1,
    totalPages = 1,
    onPageChange,
  }: {
    currentPage?: number;
    totalPages?: number;
    onPageChange: (page: number) => void;
  } = $props();

  const visiblePages = $derived(() => {
    const pages: number[] = [];
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, currentPage + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  });
</script>

<div class="join">
  <button class="join-item btn btn-sm" disabled={currentPage === 1} onclick={() => onPageChange(currentPage - 1)}>«</button>

  {#if visiblePages()[0] > 1}
    <button class="join-item btn btn-sm" onclick={() => onPageChange(1)}>1</button>
    {#if visiblePages()[0] > 2}
      <button class="join-item btn btn-sm btn-disabled">…</button>
    {/if}
  {/if}

  {#each visiblePages() as page}
    <button
      class="join-item btn btn-sm {page === currentPage ? 'btn-active' : ''}"
      onclick={() => onPageChange(page)}
    >{page}</button>
  {/each}

  {#if visiblePages()[visiblePages().length - 1] < totalPages}
    {#if visiblePages()[visiblePages().length - 1] < totalPages - 1}
      <button class="join-item btn btn-sm btn-disabled">…</button>
    {/if}
    <button class="join-item btn btn-sm" onclick={() => onPageChange(totalPages)}>{totalPages}</button>
  {/if}

  <button class="join-item btn btn-sm" disabled={currentPage === totalPages} onclick={() => onPageChange(currentPage + 1)}>»</button>
</div>
