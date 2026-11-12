<script lang="ts">
/**
 * `matrix`: the records of a relation as a grid, one row per value of `row`,
 * one column per value of `column` (declared choices first), each cell the
 * `value` of the record at that pair. With `edit`, a cell writes through
 * `host.change`: `patch` updates the record, or creates it for an empty cell.
 * An axis on a relation shows the related records' labels, read by id through
 * the data API as the user; one the caller may not read stays its id.
 */
import { type MatrixView, type ViewScope } from '@zveltio/sdk/view';
import { choicesOf, listParams, recordLabels, relatedOf, type ViewHost, WHOLE } from './engine.js';
import { readRows, type Row } from './rows.svelte.js';
import ViewRows from './ViewRows.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: MatrixView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

const data = readRows(() => ({
  collection: view.collection,
  params: listParams({}, scope, { page: 1, limit: WHOLE }),
  version: host.version,
}));

const byName = $derived(new Map(data.schema.map((f) => [f.name, f])));

/** An axis: the field's declared choices, then any other value the records hold. */
function axis(field: string): { key: string; value: unknown }[] {
  const out = choicesOf(byName.get(field)).map((c) => ({
    key: c.value,
    value: c.value as unknown,
  }));
  const seen = new Set(out.map((a) => a.key));
  for (const r of data.rows) {
    const v = r[field];
    if (v === null || v === undefined || seen.has(String(v))) continue;
    seen.add(String(v));
    out.push({ key: String(v), value: v });
  }
  return out;
}
const rowsAxis = $derived(axis(view.row));
const colsAxis = $derived(axis(view.column));
const cells = $derived(
  new Map(data.rows.map((r) => [`${String(r[view.row])}\u0000${String(r[view.column])}`, r])),
);

/** `<collection>\0<id>` → the related record's label; `null` once asked and not found. */
let labels = $state(new Map<string, string | null>());
$effect(() => {
  for (const field of [view.row, view.column]) {
    const target = relatedOf(byName.get(field));
    if (!target) continue;
    const ids = [
      ...new Set(data.rows.flatMap((r) => (r[field] == null ? [] : [String(r[field])]))),
    ].filter((id) => !labels.has(`${target}\u0000${id}`));
    if (!ids.length) continue;
    const learn = (found: Map<string, string>) => {
      const next = new Map(labels);
      for (const id of ids) next.set(`${target}\u0000${id}`, found.get(id) ?? null);
      labels = next;
    };
    // Not readable: every id is marked asked, so it is not asked again.
    recordLabels(target, ids).then(learn, () => learn(new Map()));
  }
});
const labelOf = (field: string, key: string) => {
  const target = relatedOf(byName.get(field));
  return target ? labels.get(`${target}\u0000${key}`) : null;
};

const valueType = $derived(byName.get(view.value)?.type ?? 'text');
const isBool = $derived(valueType === 'boolean');
const isNumber = $derived(['number', 'integer', 'decimal', 'float'].includes(valueType));

function write(row: unknown, col: unknown, record: Row | undefined, value: unknown) {
  if (!view.edit) return;
  void host.change(view.edit, view.collection, record ?? { [view.row]: row, [view.column]: col }, {
    [view.value]: value,
  });
}
</script>

<div class="overflow-x-auto" data-testid="view-matrix">
  <ViewRows rows={data} always>
    <table class="table table-sm">
      <thead>
        <tr>
          <th></th>
          {#each colsAxis as c (c.key)}
            <th>
              {#if labelOf(view.column, c.key)}{labelOf(view.column, c.key)}{:else}<ViewValue
                  value={c.value}
                  hint={null}
                  type={byName.get(view.column)?.type}
                />{/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rowsAxis as r (r.key)}
          <tr>
            <th>
              {#if labelOf(view.row, r.key)}{labelOf(view.row, r.key)}{:else}<ViewValue
                  value={r.value}
                  hint={null}
                  type={byName.get(view.row)?.type}
                />{/if}
            </th>
            {#each colsAxis as c (c.key)}
              {@const record = cells.get(`${r.key}\u0000${c.key}`)}
              {@const value = record?.[view.value]}
              <td data-cell={`${r.key}/${c.key}`}>
                {#if !view.edit}
                  <ViewValue {value} hint={null} type={valueType} />
                {:else if isBool}
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={value === true}
                    onchange={(e) => write(r.value, c.value, record, (e.currentTarget as HTMLInputElement).checked)}
                  />
                {:else}
                  <input
                    type={isNumber ? 'number' : 'text'}
                    class="input input-bordered input-xs w-24"
                    value={value ?? ''}
                    onchange={(e) => {
                      const v = (e.currentTarget as HTMLInputElement).value;
                      write(r.value, c.value, record, v === '' ? null : isNumber ? Number(v) : v);
                    }}
                  />
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </ViewRows>
</div>
