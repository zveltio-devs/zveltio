<script lang="ts">
/**
 * `board`: the records of a collection in columns, one per value of `groupBy`
 * (its declared choices first, in order). With `move`, a card dragged to a
 * column, or sent there from its "Move to" menu, writes the new value through
 * `host.change`: the data API or the view's action, as the user.
 */
import { type BoardView, type Field, viewFields, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { choicesOf, fieldHints, listParams, type ViewHost, WHOLE } from './engine.js';
import { readRows, type Row } from './rows.svelte.js';
import ViewRows from './ViewRows.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: BoardView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

const data = readRows(() => ({
  collection: view.collection,
  params: listParams({ filter: view.filter }, scope, { page: 1, limit: WHOLE }),
  version: host.version,
}));

const NONE = '\u0000none';
const keyOf = (v: unknown) => (v === null || v === undefined || v === '' ? NONE : String(v));
const types = $derived(new Map(data.schema.map((f) => [f.name, f.type])));

const columns = $derived.by(() => {
  const cols = choicesOf(data.schema.find((f) => f.name === view.groupBy)).map((c) => ({
    key: c.value,
    label: c.label,
    value: c.value as unknown,
  }));
  const seen = new Set(cols.map((c) => c.key));
  for (const r of data.rows) {
    const key = keyOf(r[view.groupBy]);
    if (seen.has(key)) continue;
    seen.add(key);
    cols.push({
      key,
      label: key === NONE ? m['view.none']() : String(r[view.groupBy]),
      value: key === NONE ? null : r[view.groupBy],
    });
  }
  return cols;
});

const card = $derived(
  fieldHints(
    view.card ??
      (viewFields(undefined, data.schema, 'list') as Field[])
        .filter((f) => f !== view.groupBy)
        .slice(0, 4),
  ),
);

let dragged = $state<Row | null>(null);
let over = $state<string | null>(null);

async function moveTo(row: Row, key: string) {
  const col = columns.find((c) => c.key === key);
  if (!view.move || !col || keyOf(row[view.groupBy]) === key) return;
  await host.change(view.move, view.collection, row, { [view.groupBy]: col.value });
}

function pick(row: Row) {
  if (view.id) host.scope.selected[view.id] = row.id;
}
</script>

<div data-testid="view-board">
  <ViewRows rows={data} always>
    <div class="flex gap-3 overflow-x-auto pb-2">
      {#each columns as col (col.key)}
        <section
          class="w-72 shrink-0 rounded-box bg-base-200 p-2"
          class:ring-2={over === col.key}
          aria-label={col.label}
          data-column={col.key}
          ondragover={(e) => {
            if (!view.move || !dragged) return;
            e.preventDefault();
            over = col.key;
          }}
          ondragleave={() => (over = null)}
          ondrop={(e) => {
            e.preventDefault();
            over = null;
            const row = dragged;
            dragged = null;
            if (row) void moveTo(row, col.key);
          }}
        >
          <h3 class="px-1 pb-2 text-sm font-semibold">
            {col.label}
            <span class="text-base-content/50">
              {data.rows.filter((r) => keyOf(r[view.groupBy]) === col.key).length}
            </span>
          </h3>
          <ul class="space-y-2">
            {#each data.rows.filter((r) => keyOf(r[view.groupBy]) === col.key) as row (row.id)}
              <li
                class="card bg-base-100 border border-base-300"
                class:border-primary={view.id && host.scope.selected[view.id] === row.id}
                draggable={!!view.move}
                ondragstart={(e) => {
                  dragged = row;
                  // Firefox starts a drag only with data set.
                  e.dataTransfer?.setData('text/plain', row.id);
                }}
                ondragend={() => (dragged = null)}
              >
                <button type="button" class="card-body p-3 gap-1 text-left" onclick={() => pick(row)}>
                  {#each card as { name, hint } (name)}
                    <div class="text-sm"><ViewValue value={row[name]} {hint} type={types.get(name)} /></div>
                  {/each}
                </button>
                {#if view.move}
                  <div class="px-3 pb-2">
                    <select
                      class="select select-xs select-bordered w-full"
                      aria-label={m['view.moveTo']()}
                      value={col.key}
                      onchange={(e) => {
                        const sel = e.currentTarget as HTMLSelectElement;
                        const to = sel.value;
                        // The card moves once the records read again; until then it is where it was.
                        sel.value = col.key;
                        void moveTo(row, to);
                      }}
                    >
                      {#each columns as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
                    </select>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </ViewRows>
</div>
