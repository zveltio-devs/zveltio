<script lang="ts">
/**
 * `tree`: the records of a collection under their `parent`, named by `label`,
 * siblings in `order`. A record whose parent is not among them (one the caller
 * may not read, or none) is a root. With `move`, a node dropped on
 * another node (or on the root line) takes it as its parent through
 * `host.change`; never one of its own descendants.
 */
import { type TreeView, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { isWithin, listParams, type ViewHost, WHOLE } from './engine.js';
import { readRows, type Row } from './rows.svelte.js';
import ViewRows from './ViewRows.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: TreeView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

const data = readRows(() => ({
  collection: view.collection,
  params: listParams({ sort: view.order }, scope, { page: 1, limit: WHOLE }),
  version: host.version,
}));

const ids = $derived(new Set(data.rows.map((r) => r.id)));
const parentOf = $derived(
  new Map(
    data.rows.map((r) => {
      const p = r[view.parent];
      return [r.id, p != null && ids.has(String(p)) ? String(p) : null] as const;
    }),
  ),
);
const children = $derived.by(() => {
  const out = new Map<string | null, Row[]>();
  for (const r of data.rows) {
    const p = parentOf.get(r.id) ?? null;
    out.set(p, [...(out.get(p) ?? []), r]);
  }
  return out;
});

let closed = $state(new Set<string>());
let dragged = $state<Row | null>(null);
let over = $state<string | null>(null);
const ROOT = '\u0000root';

async function moveUnder(row: Row, parent: string | null) {
  if (!view.move || parentOf.get(row.id) === parent) return;
  if (parent !== null && isWithin(row.id, parent, parentOf)) return;
  await host.change(view.move, view.collection, row, { [view.parent]: parent });
}

function toggle(id: string) {
  const next = new Set(closed);
  if (!next.delete(id)) next.add(id);
  closed = next;
}

const drop = (key: string, parent: string | null) => ({
  ondragover: (e: DragEvent) => {
    if (!view.move || !dragged) return;
    if (parent !== null && isWithin(dragged.id, parent, parentOf)) return;
    e.preventDefault();
    e.stopPropagation();
    over = key;
  },
  ondragleave: () => (over = null),
  ondrop: (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    over = null;
    const row = dragged;
    dragged = null;
    if (row) void moveUnder(row, parent);
  },
});
</script>

{#snippet branch(parent: string | null)}
  <ul class={parent === null ? 'space-y-0.5' : 'ml-5 border-l border-base-200 pl-2 space-y-0.5'}>
    {#each children.get(parent) ?? [] as row (row.id)}
      {@const kids = children.get(row.id)?.length ?? 0}
      <li>
        <div
          class="flex items-center gap-1 rounded px-1"
          class:bg-base-200={(view.id && host.scope.selected[view.id] === row.id) || over === row.id}
          draggable={!!view.move}
          data-node={row.id}
          ondragstart={(e) => {
            e.stopPropagation();
            dragged = row;
            e.dataTransfer?.setData('text/plain', row.id);
          }}
          ondragend={() => (dragged = null)}
          {...drop(row.id, row.id)}
        >
          {#if kids}
            <button
              type="button"
              class="btn btn-ghost btn-xs px-1"
              aria-expanded={!closed.has(row.id)}
              onclick={() => toggle(row.id)}>{closed.has(row.id) ? '▸' : '▾'}</button
            >
          {:else}
            <span class="w-5"></span>
          {/if}
          <button
            type="button"
            class="text-left text-sm py-0.5 flex-1"
            onclick={() => {
              if (view.id) host.scope.selected[view.id] = row.id;
            }}
          >
            <ViewValue value={row[view.label]} hint={null} />
          </button>
        </div>
        {#if kids && !closed.has(row.id)}{@render branch(row.id)}{/if}
      </li>
    {/each}
  </ul>
{/snippet}

<div data-testid="view-tree">
  <ViewRows rows={data}>
    {#if view.move}
      <div
        class="text-xs text-base-content/50 rounded px-1 mb-1"
        class:bg-base-200={over === ROOT}
        data-node="root"
        {...drop(ROOT, null)}
      >
        {m['view.none']()}
      </div>
    {/if}
    {@render branch(null)}
  </ViewRows>
</div>
