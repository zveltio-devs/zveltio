<script lang="ts">
  let {
    type = 'card',
    rows = 3,
    cols = 3,
    class: className
  }: {
    type?: 'card' | 'table' | 'list' | 'text';
    rows?: number;
    cols?: number;
    class?: string;
  } = $props();

  const baseClass = 'animate-pulse bg-base-300 dark:bg-base-700 rounded';
</script>

{#if type === 'card'}
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 {className ?? ''}">
    {#each Array.from({ length: rows * cols / 2 || 4 }) as _, i}
      <div class="card bg-base-200 p-4">
        <div class="flex items-center gap-3 mb-3">
          <div class="p-2 rounded-lg {baseClass}" style="width: 40px; height: 40px;"></div>
          <div class="flex-1 space-y-2">
            <div class="h-4 {baseClass} w-3/4"></div>
            <div class="h-2 {baseClass} w-1/2"></div>
          </div>
        </div>
        <div class="h-6 {baseClass} w-1/3"></div>
      </div>
    {/each}
  </div>

{:else if type === 'table'}
  <div class="overflow-x-auto {className ?? ''}">
    <table class="table w-full">
      <thead>
        <tr>
          {#each Array.from({ length: cols }) as _, i}
            <th><div class="h-4 {baseClass} w-24"></div></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each Array.from({ length: rows }) as _, i}
          <tr>
            {#each Array.from({ length: cols }) as _, j}
              <td><div class="h-4 {baseClass} w-full"></div></td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

{:else if type === 'list'}
  <div class="space-y-3 {className ?? ''}">
    {#each Array.from({ length: rows }) as _, i}
      <div class="flex items-center gap-3 p-3 bg-base-200 dark:bg-base-800 rounded-lg">
        <div class="w-10 h-10 rounded-full {baseClass}"></div>
        <div class="flex-1 space-y-2">
          <div class="h-4 {baseClass} w-3/4"></div>
          <div class="h-3 {baseClass} w-1/2"></div>
        </div>
      </div>
    {/each}
  </div>

{:else if type === 'text'}
  <div class="space-y-3 {className ?? ''}">
    {#each Array.from({ length: rows }) as _, i}
      <div class="h-4 {baseClass} w-full"></div>
      <div class="h-4 {baseClass} w-{Math.floor(Math.random() * 50 + 50)}%"></div>
    {/each}
  </div>
{/if}