<script lang="ts">
  /**
   * Month renderer for a saved view.
   *
   * Previously `<div>CalendarView</div>`.
   *
   * Records are placed by the first field that holds a date. Which field that
   * is has to be discovered, because a view's config does not declare one and
   * collections disagree — `due_date`, `starts_at`, `scheduled_for`,
   * `created_at`. Preferring a domain date over `created_at` matters: a
   * calendar of when rows were inserted is not what anyone asked for, so
   * `created_at` is the last resort rather than the first match.
   *
   * Deliberately month-only. Week and day views are a different component with
   * different layout rules, and a half-built switcher is what this file already
   * was.
   */
  let {
    items = [],
    dateField = null,
    onEventClick = null,
  }: {
    items: Record<string, unknown>[];
    dateField?: string | null;
    onEventClick?: ((item: Record<string, unknown>) => void) | null;
  } = $props();

  /** Preferred first; `created_at` only if nothing domain-specific exists. */
  const DATE_FIELDS = [
    'date',
    'due_date',
    'start_date',
    'starts_at',
    'scheduled_for',
    'event_date',
    'created_at',
  ];

  const TITLE_FIELDS = ['name', 'title', 'label', 'subject'];

  const field = $derived(
    dateField ?? DATE_FIELDS.find((f) => items.some((i) => parseDate(i[f]) !== null)) ?? null,
  );

  let cursor = $state(new Date());

  function parseDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function titleOf(item: Record<string, unknown>): string {
    for (const f of TITLE_FIELDS) {
      const v = item[f];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return String(item.id ?? '—');
  }

  /** Local-time day key. `toISOString` would bucket by UTC and shift events. */
  function dayKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  const byDay = $derived.by(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    if (!field) return map;
    for (const item of items) {
      const d = parseDate(item[field]);
      if (!d) continue;
      const key = dayKey(d);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  });

  /** Six weeks from the Monday on or before the 1st — a stable month grid. */
  const grid = $derived.by(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Monday = 0
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  });

  const monthLabel = $derived(
    cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  );

  const today = dayKey(new Date());

  function shiftMonth(delta: number) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
  }
</script>

{#if !field}
  <div class="text-sm opacity-60 py-8 text-center">
    No date field found on these records, so there is nothing to place on a calendar.
  </div>
{:else}
  <div class="flex items-center justify-between mb-3">
    <button class="btn btn-sm btn-ghost" onclick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
    <div class="font-medium text-sm">
      {monthLabel}
      <span class="opacity-50 font-normal">· {field}</span>
    </div>
    <button class="btn btn-sm btn-ghost" onclick={() => shiftMonth(1)} aria-label="Next month">›</button>
  </div>

  <div class="grid grid-cols-7 gap-px bg-base-300 border border-base-300 rounded overflow-hidden">
    {#each ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as label}
      <div class="bg-base-200 text-xs font-medium p-1 text-center">{label}</div>
    {/each}

    {#each grid as day}
      {@const key = dayKey(day)}
      {@const events = byDay.get(key) ?? []}
      {@const outside = day.getMonth() !== cursor.getMonth()}
      <div
        class="bg-base-100 min-h-20 p-1 align-top {outside ? 'opacity-40' : ''} {key === today
          ? 'ring-1 ring-primary ring-inset'
          : ''}"
      >
        <div class="text-xs opacity-60 mb-1">{day.getDate()}</div>
        {#each events.slice(0, 3) as ev}
          <button
            class="block w-full text-left text-xs truncate badge badge-sm badge-primary mb-0.5"
            title={titleOf(ev)}
            onclick={() => onEventClick?.(ev)}
          >{titleOf(ev)}</button>
        {/each}
        {#if events.length > 3}
          <div class="text-xs opacity-60">+{events.length - 3}</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
