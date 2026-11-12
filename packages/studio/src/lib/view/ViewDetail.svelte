<script lang="ts">
/** `detail`: one record through the data API, its fields, then its panels (`$record` is it). */
import {
  type DetailView,
  resolveValue,
  type SchemaField,
  viewFields,
  type ViewScope,
} from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { dataApi } from '#lib/api.js';
import { fieldHints, schemaOf, type ViewHost } from './engine.js';
import ViewNode from './ViewNode.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: DetailView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

let schema = $state<SchemaField[]>([]);
let record = $state<Record<string, unknown> | null>(null);
let error = $state<string | null>(null);

const id = $derived(resolveValue(view.record, scope));

$effect(() => {
  schemaOf(view.collection).then(
    (s) => (schema = s),
    () => {},
  );
});

$effect(() => {
  const rid = id;
  void host.version;
  if (rid === undefined || rid === null) return;
  dataApi
    .get(view.collection, String(rid))
    .then((r) => {
      record = r;
      error = null;
    })
    .catch((e: Error) => (error = e.message || m['ext.loadFailed']()));
});

const fields = $derived(fieldHints(viewFields(view.fields, schema, 'detail')));
const byName = $derived(new Map(schema.map((f) => [f.name, f])));
function label(name: string, hint: { label?: string } | null): string {
  if (hint?.label) return host.t(hint.label);
  const l = byName.get(name)?.label;
  return typeof l === 'string' && l ? l : name.replace(/_/g, ' ');
}
</script>

<div class="space-y-4" data-testid="view-detail">
  {#if id === undefined || id === null}
    <p class="text-sm text-base-content/65 py-6 text-center">{m['view.selectFirst']()}</p>
  {:else if error}
    <div class="alert alert-error text-sm">{error}</div>
  {:else if !record}
    <span class="loading loading-spinner loading-sm"></span>
  {:else}
    <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {#each fields as { name, hint } (name)}
        <dt class="text-base-content/65">{label(name, hint)}</dt>
        <dd><ViewValue value={record[name]} {hint} type={byName.get(name)?.type} /></dd>
      {/each}
    </dl>
    {#each view.panels ?? [] as panel, i (i)}
      <div class="border-t border-base-200 pt-4">
        <ViewNode view={panel} {host} {record} />
      </div>
    {/each}
  {/if}
</div>
