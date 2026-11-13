<script lang="ts">
/**
 * `list`: rows of a collection through the data API, as the signed-in user.
 * With no `fields` it shows the collection's generated default columns.
 */
import {
  type Field,
  type ListView,
  matches,
  type SchemaField,
  viewFields,
  type ViewScope,
} from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import Pagination from '#lib/components/common/Pagination.svelte';
import Modal from '#lib/components/common/Modal.svelte';
import {
  fieldHints,
  listParams,
  listRecords,
  schemaOf,
  shownValue,
  type ViewHost,
} from './engine.js';
import ViewButtons from './ViewButtons.svelte';
import ViewForm from './ViewForm.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: ListView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

type Row = Record<string, unknown> & { id: string };

let schema = $state<SchemaField[]>([]);
let rows = $state<Row[]>([]);
let total = $state(0);
let page = $state(1);
let search = $state('');
let loading = $state(true);
let error = $state<string | null>(null);
let waiting = $state(false);
let chosen = $state(new Set<string>());
let creating = $state(false);
let editing = $state<Row | null>(null);

const limit = $derived(view.pageSize ?? 25);
const fields = $derived(fieldHints(viewFields(view.fields, schema, 'list') as Field[]));
const labels = $derived(new Map(schema.map((f) => [f.name, f])));
const params = $derived(listParams(view, scope, { page, limit, search }));

$effect(() => {
  schemaOf(view.collection).then(
    (s) => (schema = s),
    (e: Error) => (error = e.message || m['ext.loadFailed']()),
  );
});

let seq = 0;
$effect(() => {
  const p = params;
  void host.version;
  waiting = p === null;
  if (!p) return;
  const mine = ++seq;
  loading = true;
  listRecords(view.collection, p)
    .then((res) => {
      if (mine !== seq) return;
      rows = res.records as Row[];
      total = res.pagination?.total ?? rows.length;
      error = null;
      // A re-read (after an action, or while a button is busy) keeps the rows still there.
      chosen = new Set(rows.filter((r) => chosen.has(r.id)).map((r) => r.id));
    })
    .catch((e: Error) => {
      if (mine === seq) error = e.message || m['ext.loadFailed']();
    })
    .finally(() => {
      if (mine === seq) loading = false;
    });
});

function label(name: string, hint: { label?: string } | null): string {
  if (hint?.label) return host.t(hint.label);
  const f = labels.get(name);
  return typeof f?.label === 'string' && f.label ? f.label : name.replace(/_/g, ' ');
}

function openRow(row: Row) {
  if (view.id) host.scope.selected[view.id] = row.id;
  if (view.open) void host.press({ navigate: view.open, params: { id: row.id } }, scope);
}

const rowScope = (row: Row): ViewScope => ({ ...scope, record: row });
const selection = $derived(rows.filter((r) => chosen.has(r.id)));
const cards = $derived(view.present === 'cards' || view.present === 'feed');
const rowButtons = $derived(!!view.rowActions?.length || !!view.edit || !!view.delete);
</script>

{#snippet rowControls(row: Row)}
  <div class="flex flex-wrap gap-2">
    <ViewButtons buttons={view.rowActions} {host} scope={rowScope(row)} size="xs" />
    {#if view.edit}
      <button type="button" class="btn btn-xs btn-outline" onclick={() => (editing = row)}>
        {m['common.edit']()}
      </button>
    {/if}
    {#if view.delete}
      <button
        type="button"
        class="btn btn-xs btn-outline btn-error"
        onclick={() => host.remove(view.collection, row.id)}
      >
        {m['common.delete']()}
      </button>
    {/if}
  </div>
{/snippet}

<div class="space-y-3" data-testid="view-list">
  {#if view.search || view.create || (view.selectable && view.bulkActions?.length)}
    <div class="flex flex-wrap items-center gap-2">
      {#if view.search}
        <input
          class="input input-bordered input-sm w-64"
          placeholder={m['common.search']()}
          value={search}
          oninput={(e) => {
            search = (e.currentTarget as HTMLInputElement).value;
            page = 1;
          }}
        />
      {/if}
      {#if view.selectable && selection.length}
        <ViewButtons buttons={view.bulkActions} {host} scope={{ ...scope, selection }} />
      {/if}
      {#if view.create}
        <button class="btn btn-primary btn-sm ml-auto" onclick={() => (creating = true)}>
          {m['common.new']()}
        </button>
      {/if}
    </div>
  {/if}

  {#if waiting}
    <p class="text-sm text-base-content/65 py-6 text-center">{m['view.selectFirst']()}</p>
  {:else if error}
    <div class="alert alert-error text-sm">{error}</div>
  {:else if loading && rows.length === 0}
    <span class="loading loading-spinner loading-sm"></span>
  {:else if rows.length === 0}
    <p class="text-sm text-base-content/65 py-6 text-center">{m['common.noResults']()}</p>
  {:else if cards}
    <div class={view.present === 'feed' ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'}>
      {#each rows as row (row.id)}
        <div
          class="card bg-base-100 border border-base-200"
          class:border-primary={view.id && host.scope.selected[view.id] === row.id}
          class:font-semibold={matches(view.emphasisWhen, row, rowScope(row)) && !!view.emphasisWhen}
        >
          <button type="button" class="card-body p-4 gap-1 text-left" onclick={() => openRow(row)}>
            {#each fields as { name, hint } (name)}
              {@const shown = shownValue(row, name, hint, labels)}
              <div class="text-sm"><ViewValue value={shown.value} {hint} type={shown.type} /></div>
            {/each}
          </button>
          {#if rowButtons}
            <div class="px-4 pb-3">{@render rowControls(row)}</div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            {#if view.selectable}<th class="w-8"></th>{/if}
            {#each fields as { name, hint } (name)}<th>{label(name, hint)}</th>{/each}
            {#if rowButtons}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr
              class="hover cursor-pointer"
              class:bg-base-200={view.id && host.scope.selected[view.id] === row.id}
              class:font-semibold={!!view.emphasisWhen && matches(view.emphasisWhen, row, rowScope(row))}
              onclick={() => openRow(row)}
            >
              {#if view.selectable}
                <td>
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    checked={chosen.has(row.id)}
                    onclick={(e) => e.stopPropagation()}
                    onchange={(e) => {
                      const next = new Set(chosen);
                      if ((e.currentTarget as HTMLInputElement).checked) next.add(row.id);
                      else next.delete(row.id);
                      chosen = next;
                    }}
                  />
                </td>
              {/if}
              {#each fields as { name, hint } (name)}
                {@const shown = shownValue(row, name, hint, labels)}
                <td><ViewValue value={shown.value} {hint} type={shown.type} /></td>
              {/each}
              {#if rowButtons}
                <td onclick={(e) => e.stopPropagation()}>{@render rowControls(row)}</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <Pagination {total} {page} {limit} onchange={(p) => (page = p)} />
</div>

{#if creating}
  <Modal open={true} title={m['common.new']()} size="lg" onClose={() => (creating = false)}>
    <ViewForm
      view={{ type: 'form', collection: view.collection }}
      {host}
      {scope}
      onDone={() => {
        creating = false;
        host.version++;
      }}
    />
  </Modal>
{/if}

{#if editing}
  <Modal open={true} title={m['common.edit']()} size="lg" onClose={() => (editing = null)}>
    <ViewForm
      view={{ type: 'form', collection: view.collection, record: { $record: 'id' } }}
      {host}
      scope={rowScope(editing)}
      onDone={() => {
        editing = null;
        host.version++;
      }}
    />
  </Modal>
{/if}
