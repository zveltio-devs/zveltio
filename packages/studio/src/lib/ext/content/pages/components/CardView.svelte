<script lang="ts">
  /**
   * Card renderer for a saved view.
   *
   * Previously `<div class="CardView">CardView Component</div>` — a placeholder
   * that shipped. An audit reported it, correctly, as not being production UI.
   *
   * A card needs a title, which no view config declares, so it is inferred from
   * the first field that reads like one. Guessing beats demanding here: a view
   * created with an empty config is the normal starting state, and a renderer
   * that refuses to draw until someone edits JSON is a renderer nobody sees.
   */
  let {
    items = [],
    columns = [],
    onCardClick = null,
  }: {
    items: Record<string, unknown>[];
    columns?: string[];
    onCardClick?: ((item: Record<string, unknown>) => void) | null;
  } = $props();

  const INTERNAL = new Set(['id', 'tenant_id', 'created_by', 'updated_by', 'deleted_at']);
  /** Fields that usually carry a human-readable label, in order of preference. */
  const TITLE_FIELDS = ['name', 'title', 'label', 'subject', 'display_name', 'email'];

  const fields = $derived(
    columns.length > 0
      ? columns
      : Object.keys(items[0] ?? {}).filter((k) => !INTERNAL.has(k)),
  );

  function titleOf(item: Record<string, unknown>): string {
    for (const f of TITLE_FIELDS) {
      const v = item[f];
      if (typeof v === 'string' && v.trim()) return v;
    }
    // Nothing name-like: the id is at least stable and identifies the row.
    return String(item.id ?? '—');
  }

  function bodyFields(item: Record<string, unknown>): string[] {
    const used = TITLE_FIELDS.find((f) => typeof item[f] === 'string' && item[f]);
    return fields.filter((f) => f !== used).slice(0, 4);
  }

  function cell(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? '✓' : '—';
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
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
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each items as item}
      <div
        class="card bg-base-100 shadow-sm border border-base-300 {onCardClick
          ? 'cursor-pointer hover:shadow-md transition-shadow'
          : ''}"
        onclick={() => onCardClick?.(item)}
        role={onCardClick ? 'button' : undefined}
        tabindex={onCardClick ? 0 : undefined}
        onkeydown={(e) => {
          if (onCardClick && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onCardClick(item);
          }
        }}
      >
        <div class="card-body p-4 gap-2">
          <h3 class="font-medium text-sm truncate" title={titleOf(item)}>{titleOf(item)}</h3>
          <dl class="text-xs space-y-1">
            {#each bodyFields(item) as f}
              <div class="flex gap-2">
                <dt class="opacity-60 shrink-0">{f}</dt>
                <dd class="truncate" title={cell(item[f])}>{cell(item[f])}</dd>
              </div>
            {/each}
          </dl>
        </div>
      </div>
    {/each}
  </div>
{/if}
