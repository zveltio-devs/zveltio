<script lang="ts">
  interface Props {
    rows?: number;
    cols?: number;
    type?: 'table' | 'card' | 'list' | 'text';
    class?: string;
  }
  let { rows = 5, cols = 4, type = 'table', class: className = '' }: Props = $props();
</script>

{#if type === 'table'}
  <div class="w-full overflow-hidden rounded-lg border border-base-300 {className}">
    <!-- Header -->
    <div class="flex gap-3 bg-base-200 px-4 py-3">
      {#each Array(cols) as _}
        <div class="skeleton h-4 flex-1 rounded"></div>
      {/each}
    </div>
    <!-- Rows -->
    {#each Array(rows) as _, i}
      <div class="flex gap-3 border-t border-base-200 px-4 py-3 {i % 2 === 0 ? '' : 'bg-base-50'}">
        {#each Array(cols) as _, j}
          <div class="skeleton h-4 flex-1 rounded" style="width: {60 + Math.sin(i * 3 + j) * 20}%"></div>
        {/each}
      </div>
    {/each}
  </div>

{:else if type === 'card'}
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 {className}">
    {#each Array(rows) as _}
      <div class="card bg-base-100 border border-base-300 p-4">
        <div class="skeleton mb-3 h-5 w-2/3 rounded"></div>
        <div class="skeleton mb-2 h-3 w-full rounded"></div>
        <div class="skeleton h-3 w-4/5 rounded"></div>
      </div>
    {/each}
  </div>

{:else if type === 'list'}
  <div class="space-y-2 {className}">
    {#each Array(rows) as _}
      <div class="flex items-center gap-3 rounded-lg border border-base-200 px-4 py-3">
        <div class="skeleton h-8 w-8 shrink-0 rounded-full"></div>
        <div class="flex-1 space-y-1">
          <div class="skeleton h-4 w-1/3 rounded"></div>
          <div class="skeleton h-3 w-1/2 rounded"></div>
        </div>
      </div>
    {/each}
  </div>

{:else}
  <!-- text -->
  <div class="space-y-2 {className}">
    {#each Array(rows) as _, i}
      <div class="skeleton h-4 rounded" style="width: {i === rows - 1 ? '60%' : '100%'}"></div>
    {/each}
  </div>
{/if}
