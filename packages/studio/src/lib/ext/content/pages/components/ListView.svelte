<script lang="ts">
  /**
   * Tabular renderer for a saved view.
   *
   * This rendered `JSON.stringify(item, null, 2)` inside a card — the shape a
   * component takes while someone is still deciding what it should look like.
   * It never became anything else, and an audit reported it as not being
   * production UI, which it was not.
   *
   * Columns come from the view's `config.columns` when it names any; otherwise
   * the keys of the first record, minus the bookkeeping ones an operator did
   * not ask to see. Deriving them rather than demanding them means a view
   * created with an empty config still renders something useful, which is the
   * state every view starts in.
   */
  let {
    items = [],
    columns = [],
    onRowClick = null,
  }: {
    items: Record<string, unknown>[];
    columns?: string[];
    onRowClick?: ((item: Record<string, unknown>) => void) | null;
  } = $props();

  /** Columns the engine maintains; showing them by default is noise. */
  const INTERNAL = new Set(['tenant_id', 'created_by', 'updated_by', 'deleted_at']);

  const resolved = $derived(
    columns.length > 0
      ? columns
      : Object.keys(items[0] ?? {}).filter((k) => !INTERNAL.has(k)),
  );

  /**
   * Render a cell without letting an object collapse to "[object Object]".
   *
   * Dates are the common case in these collections and read badly as ISO
   * strings in a table, so they get the locale's short form.
   */
  function cell(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? '✓' : '—';
    if (value instanceof Date) return value.toLocaleDateString();
    if (typeof value === 'string') {
      // An ISO timestamp is far more common here than a string that merely
      // looks like one, and Date.parse on a non-date returns NaN, so this is
      // safe to attempt.
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toLocaleString();
      }
      return value;
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
</script>

{#if items.length === 0}
  <div class="text-sm opacity-60 py-8 text-center">No records.</div>
{:else}
  <div class="overflow-x-auto">
    <table class="table table-sm table-zebra">
      <thead>
        <tr>
          {#each resolved as col}
            <th class="whitespace-nowrap">{col}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each items as item}
          <tr
            class={onRowClick ? 'cursor-pointer hover' : ''}
            onclick={() => onRowClick?.(item)}
          >
            {#each resolved as col}
              <td class="max-w-xs truncate" title={cell(item[col])}>{cell(item[col])}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
