<script lang="ts">
  interface Props {
    currentPage: number;
    totalPages: number;
    totalRecords: number;
    pageSize: number;
    onPageChange: (page: number) => void;
    onPageSizeChange?: (size: number) => void;
  }

  let {
    currentPage,
    totalPages,
    totalRecords,
    pageSize,
    onPageChange,
    onPageSizeChange,
  }: Props = $props();

  const pageSizeOptions = [10, 25, 50, 100];

  const from = $derived((currentPage - 1) * pageSize + 1);
  const to = $derived(Math.min(currentPage * pageSize, totalRecords));

  const visiblePages = $derived(() => {
    const pages: number[] = [];
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, currentPage + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  });
</script>

<div class="flex items-center justify-between flex-wrap gap-3">
  <div class="flex items-center gap-3">
    <span class="text-sm opacity-60">
      Showing {totalRecords === 0 ? 0 : from}–{to} of {totalRecords} records
    </span>

    {#if onPageSizeChange}
      <div class="flex items-center gap-1">
        <span class="text-xs opacity-50">Per page:</span>
        <select
          class="select select-xs select-bordered"
          value={pageSize}
          onchange={(e) => onPageSizeChange(parseInt((e.target as HTMLSelectElement).value))}
        >
          {#each pageSizeOptions as size}
            <option value={size}>{size}</option>
          {/each}
        </select>
      </div>
    {/if}
  </div>

  {#if totalPages > 1}
    <div class="join">
      <button class="join-item btn btn-sm" disabled={currentPage === 1} onclick={() => onPageChange(1)} title="First">«</button>
      <button class="join-item btn btn-sm" disabled={currentPage === 1} onclick={() => onPageChange(currentPage - 1)} title="Previous">‹</button>

      {#each visiblePages() as page}
        <button
          class="join-item btn btn-sm {page === currentPage ? 'btn-active' : ''}"
          onclick={() => onPageChange(page)}
        >{page}</button>
      {/each}

      <button class="join-item btn btn-sm" disabled={currentPage === totalPages} onclick={() => onPageChange(currentPage + 1)} title="Next">›</button>
      <button class="join-item btn btn-sm" disabled={currentPage === totalPages} onclick={() => onPageChange(totalPages)} title="Last">»</button>
    </div>
  {/if}
</div>
