<script lang="ts">
/**
 * `timeline`: records on a time axis, one period at a time — an agenda of a
 * day or a week, a month calendar, or a Gantt of a month. The period is part
 * of the data API filter (`periodQueries`; a record with an empty `end` is a
 * point at its start). With `move`, a record dropped on another day, or given
 * one in its menu, moves by whole days, its `end` with it, through `host.change`.
 */
import { type TimelineView, viewFields, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import {
  dayDate,
  dayKey,
  daysBetween,
  listParams,
  localDay,
  period,
  periodQueries,
  shiftDays,
  type ViewHost,
  WHOLE,
} from './engine.js';
import { readRows, type Row } from './rows.svelte.js';
import ViewRows from './ViewRows.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: TimelineView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

const scale = $derived(view.scale ?? 'month');
let anchor = $state(localDay(new Date()));
const days = $derived(period(anchor, scale));
const from = $derived(days[0]);
const until = $derived(shiftDays(days[days.length - 1], 1) as string);

const data = readRows(() => {
  const queries = periodQueries(view.filter ?? [], view.start, view.end, from, until).map(
    (filter) => listParams({ filter, sort: view.start }, scope, { page: 1, limit: WHOLE }),
  );
  return {
    collection: view.collection,
    params: queries.some((q) => q === null) ? null : (queries as Record<string, string | number>[]),
    version: host.version,
  };
});

/** What names a record on the axis: its first listed field that is not a date of the axis. */
const labelField = $derived(
  (viewFields(undefined, data.schema, 'list') as string[]).find(
    (f) => f !== view.start && f !== view.end && f !== view.groupBy,
  ) ?? 'id',
);

interface Item {
  row: Row;
  start: string;
  end: string;
}
const items = $derived.by((): Item[] =>
  data.rows.flatMap((row) => {
    const start = dayKey(row[view.start]);
    if (!start) return [];
    const end = (view.end && dayKey(row[view.end])) || start;
    return [{ row, start, end: end < start ? start : end }];
  }),
);
const on = (day: string) => items.filter((i) => i.start <= day && day <= i.end);

const shownItems = $derived(items.filter((i) => i.start < until && i.end >= from));
const lanes = $derived(
  view.groupBy
    ? [...shownItems].sort((a, b) =>
        String(a.row[view.groupBy as string] ?? '').localeCompare(
          String(b.row[view.groupBy as string] ?? ''),
        ),
      )
    : shownItems,
);

function step(dir: -1 | 1) {
  if (scale === 'day') anchor = shiftDays(anchor, dir) as string;
  else if (scale === 'week') anchor = shiftDays(anchor, 7 * dir) as string;
  else {
    const d = dayDate(anchor);
    anchor = localDay(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }
}

const heading = $derived(
  scale === 'month' || scale === 'gantt'
    ? dayDate(from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : days.length === 1
      ? dayDate(from).toLocaleDateString(undefined, { dateStyle: 'full' })
      : `${dayDate(from).toLocaleDateString()} – ${dayDate(days[days.length - 1]).toLocaleDateString()}`,
);
const weekday = (day: string) => dayDate(day).toLocaleDateString(undefined, { weekday: 'short' });
const lead = $derived((dayDate(from).getDay() + 6) % 7);

let dragged = $state<Item | null>(null);
let over = $state<string | null>(null);

async function moveTo(item: Item, day: string) {
  const n = daysBetween(item.start, day);
  if (!view.move || n === 0) return;
  const patch: Record<string, unknown> = { [view.start]: shiftDays(item.row[view.start], n) };
  if (view.end && item.row[view.end] != null) patch[view.end] = shiftDays(item.row[view.end], n);
  await host.change(view.move, view.collection, item.row, patch);
}

function pick(row: Row) {
  if (view.id) host.scope.selected[view.id] = row.id;
}

const drop = (day: string) => ({
  ondragover: (e: DragEvent) => {
    if (!view.move || !dragged) return;
    e.preventDefault();
    over = day;
  },
  ondragleave: () => (over = null),
  ondrop: (e: DragEvent) => {
    e.preventDefault();
    over = null;
    const item = dragged;
    dragged = null;
    if (item) void moveTo(item, day);
  },
});
</script>

{#snippet chip(item: Item)}
  {#if view.move}
    <!-- The keyboard's way to move: the record's menu takes a day. -->
    <details class="dropdown w-full">
      <summary
        class="badge badge-sm badge-primary badge-outline w-full justify-start truncate list-none cursor-pointer"
        class:badge-soft={view.id && host.scope.selected[view.id] === item.row.id}
        draggable="true"
        data-record={item.row.id}
        ondragstart={(e) => {
          dragged = item;
          e.dataTransfer?.setData('text/plain', item.row.id);
        }}
        ondragend={() => (dragged = null)}
        onclick={() => pick(item.row)}
      >
        <ViewValue value={item.row[labelField]} hint={null} />
      </summary>
      <div class="dropdown-content z-10 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        <input
          type="date"
          class="input input-xs input-bordered"
          aria-label={m['view.moveTo']()}
          value={item.start}
          onchange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            const to = input.value;
            // The record moves once the records read again; until then it is where it was.
            input.value = item.start;
            if (/^\d{4}-\d{2}-\d{2}$/.test(to)) void moveTo(item, to);
          }}
        />
      </div>
    </details>
  {:else}
    <button
      type="button"
      class="badge badge-sm badge-primary badge-outline w-full justify-start truncate"
      class:badge-soft={view.id && host.scope.selected[view.id] === item.row.id}
      data-record={item.row.id}
      onclick={() => pick(item.row)}
    >
      <ViewValue value={item.row[labelField]} hint={null} />
    </button>
  {/if}
{/snippet}

<div class="space-y-3" data-testid="view-timeline">
  <div class="flex items-center gap-2">
    <button type="button" class="btn btn-sm btn-ghost" onclick={() => step(-1)}>{m['common.prev']()}</button>
    <button type="button" class="btn btn-sm btn-ghost" onclick={() => (anchor = localDay(new Date()))}>
      {m['view.today']()}
    </button>
    <button type="button" class="btn btn-sm btn-ghost" onclick={() => step(1)}>{m['common.next']()}</button>
    <h3 class="font-semibold">{heading}</h3>
  </div>

  <ViewRows rows={data} always>
    {#if scale === 'month'}
      <div class="grid grid-cols-7 gap-px rounded-box bg-base-300 overflow-hidden text-sm">
        {#each days.slice(0, 7) as _, i (i)}
          <div class="bg-base-200 px-2 py-1 font-semibold">{weekday(days[(i - lead + 7) % 7])}</div>
        {/each}
        {#each Array(lead) as _, i (i)}<div class="bg-base-100"></div>{/each}
        {#each days as day (day)}
          <div class="bg-base-100 min-h-20 p-1 space-y-1" class:ring-2={over === day} data-day={day} {...drop(day)}>
            <div class="text-xs text-base-content/60">{dayDate(day).getDate()}</div>
            {#each on(day) as item (item.row.id)}{@render chip(item)}{/each}
          </div>
        {/each}
      </div>
    {:else if scale === 'gantt'}
      <div class="overflow-x-auto text-sm">
        <div class="grid gap-y-1" style={`grid-template-columns: 12rem repeat(${days.length}, minmax(1.5rem, 1fr))`}>
          <div></div>
          {#each days as day (day)}<div class="text-center text-xs text-base-content/60">{dayDate(day).getDate()}</div>{/each}
          {#each lanes as item (item.row.id)}
            <div class="truncate pr-2">
              {#if view.groupBy}<span class="text-base-content/60">{String(item.row[view.groupBy] ?? '')}</span>{/if}
              <ViewValue value={item.row[labelField]} hint={null} />
            </div>
            <div class="grid" style={`grid-column: span ${days.length}; grid-template-columns: repeat(${days.length}, minmax(1.5rem, 1fr))`}>
              {#each days as day, i (day)}
                <div class="border-l border-base-200 min-h-6" class:bg-base-200={over === day} style={`grid-row: 1; grid-column: ${i + 1}`} data-day={day} {...drop(day)}></div>
              {/each}
              <div
                class="self-center"
                style={`grid-row: 1; grid-column: ${Math.max(0, daysBetween(from, item.start)) + 1} / ${Math.min(days.length - 1, daysBetween(from, item.end)) + 2}`}
              >
                {@render chip(item)}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="space-y-3">
        {#each days as day (day)}
          <section class="rounded-box border border-base-200 p-2" class:ring-2={over === day} data-day={day} {...drop(day)}>
            <h4 class="text-sm font-semibold mb-1">{dayDate(day).toLocaleDateString(undefined, { dateStyle: 'full' })}</h4>
            {#each on(day) as item (item.row.id)}
              <div class="flex items-center gap-2">
                {#if view.groupBy}<span class="text-xs text-base-content/60">{String(item.row[view.groupBy] ?? '')}</span>{/if}
                <div class="flex-1 min-w-0">{@render chip(item)}</div>
              </div>
            {:else}
              <p class="text-xs text-base-content/50">—</p>
            {/each}
          </section>
        {/each}
      </div>
    {/if}
  </ViewRows>
</div>
