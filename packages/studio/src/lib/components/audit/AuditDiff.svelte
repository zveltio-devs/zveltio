<script lang="ts">
  // Shows a visual before/after diff for a revision delta.

  interface DeltaChange {
    from: any;
    to: any;
  }

  interface Props {
    delta: Record<string, DeltaChange> | null;
    compact?: boolean;
  }

  let { delta, compact = false }: Props = $props();

  function stringify(v: any): string {
    if (v === null || v === undefined) return '(empty)';
    if (typeof v === 'object') return JSON.stringify(v, null, compact ? 0 : 2);
    return String(v);
  }

  const entries = $derived(delta ? Object.entries(delta) : []);
</script>

{#if entries.length === 0}
  <p class="text-xs opacity-40 italic">No changes</p>
{:else}
  <div class="space-y-2">
    {#each entries as [field, change]}
      <div class="border border-base-300 rounded overflow-hidden">
        <div class="px-2 py-1 bg-base-200 text-xs font-mono font-bold text-base-content/70">{field}</div>
        <div class="grid grid-cols-2 divide-x divide-base-300">
          <div class="p-2 bg-error/5">
            <div class="text-[10px] text-error font-semibold mb-1">BEFORE</div>
            <pre class="text-xs whitespace-pre-wrap break-all text-error/80 line-through">{stringify(change.from)}</pre>
          </div>
          <div class="p-2 bg-success/5">
            <div class="text-[10px] text-success font-semibold mb-1">AFTER</div>
            <pre class="text-xs whitespace-pre-wrap break-all text-success/80">{stringify(change.to)}</pre>
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}
