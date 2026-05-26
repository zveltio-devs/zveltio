<script lang="ts">
/**
 * Skeleton placeholders for content-shape loading states.
 *
 * Uses `.animate-shimmer` (defined in app.css) — a moving gradient
 * that's friendlier than `animate-pulse` because it suggests motion
 * (data flowing in) rather than blinking (something might be broken).
 *
 * Variants:
 *   - card    — 2×2 grid of stat-card placeholders.
 *   - table   — full table with header + N rows.
 *   - list    — row of avatar + two lines (audit log, comments).
 *   - text    — paragraph-style lines, varied widths.
 */
let {
  type = 'card',
  rows = 3,
  cols = 3,
  class: className,
}: {
  type?: 'card' | 'table' | 'list' | 'text';
  rows?: number;
  cols?: number;
  class?: string;
} = $props();

const skel = 'animate-shimmer rounded-md';
</script>

{#if type === 'card'}
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 {className ?? ''}" aria-busy="true" aria-label="Loading">
    {#each Array.from({ length: Math.max(2, rows) }) as _}
      <div class="card bg-base-200/60 shadow-z1 p-4">
        <div class="flex items-center gap-3 mb-3">
          <div class="{skel} w-10 h-10 rounded-xl"></div>
          <div class="flex-1 space-y-2">
            <div class="{skel} h-3 w-3/4"></div>
            <div class="{skel} h-2 w-1/2"></div>
          </div>
        </div>
        <div class="{skel} h-7 w-1/3"></div>
      </div>
    {/each}
  </div>

{:else if type === 'table'}
  <div class="overflow-x-auto {className ?? ''}" aria-busy="true" aria-label="Loading">
    <table class="table w-full">
      <thead>
        <tr>
          {#each Array.from({ length: cols }) as _}
            <th><div class="{skel} h-3 w-20"></div></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each Array.from({ length: rows }) as _}
          <tr>
            {#each Array.from({ length: cols }) as _}
              <td><div class="{skel} h-3 w-full"></div></td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

{:else if type === 'list'}
  <div class="space-y-3 {className ?? ''}" aria-busy="true" aria-label="Loading">
    {#each Array.from({ length: rows }) as _}
      <div class="flex items-center gap-3 p-3 bg-base-200/60 shadow-z1 rounded-xl">
        <div class="{skel} w-10 h-10 rounded-full"></div>
        <div class="flex-1 space-y-2">
          <div class="{skel} h-3 w-3/4"></div>
          <div class="{skel} h-2 w-1/2"></div>
        </div>
      </div>
    {/each}
  </div>

{:else if type === 'text'}
  <!-- Deterministic widths (no random()) — Tailwind needs static classes. -->
  <div class="space-y-3 {className ?? ''}" aria-busy="true" aria-label="Loading">
    {#each Array.from({ length: rows }) as _, i}
      <div class="{skel} h-3 {i % 3 === 0 ? 'w-full' : i % 3 === 1 ? 'w-5/6' : 'w-2/3'}"></div>
    {/each}
  </div>
{/if}
