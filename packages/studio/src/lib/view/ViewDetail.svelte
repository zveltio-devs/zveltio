<script lang="ts">
/**
 * `detail`: one record through the data API, its toolbar, its fields, then its
 * panels; `$record` is the record in all three. `onOpen` runs once per record
 * shown that meets its `when`.
 */
import {
  type DetailView,
  matches,
  resolveInput,
  resolveValue,
  type SchemaField,
  viewFields,
  type ViewScope,
} from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { dataApi } from '#lib/api.js';
import { fieldHints, schemaOf, shownValue, type ViewHost } from './engine.js';
import ViewButtons from './ViewButtons.svelte';
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
    (e: Error) => (error = e.message || m['ext.loadFailed']()),
  );
});

let seq = 0;
$effect(() => {
  const rid = id;
  void host.version;
  const mine = ++seq;
  if (rid === undefined || rid === null) return;
  dataApi
    .get(view.collection, String(rid))
    .then((r) => {
      // A newer selection is already loading: this record is no longer the one shown.
      if (mine !== seq) return;
      record = r;
      error = null;
    })
    .catch((e: Error) => {
      if (mine === seq) error = e.message || m['ext.loadFailed']();
    });
});

/** The record `onOpen` last ran for: once per record, not on every read after it. */
let opened: unknown = null;
$effect(() => {
  const r = record;
  const o = view.onOpen;
  if (!o || !r || r.id === opened || !host.canRun(o.action)) return;
  opened = r.id;
  const s = { ...scope, record: r };
  if (!matches(o.when, r, s)) return;
  const input = resolveInput(o.input, s);
  if (input) void host.run(o.action, input, { quiet: true });
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
    <ViewButtons buttons={view.actions} {host} scope={{ ...scope, record }} />
    <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {#each fields as { name, hint } (name)}
        {@const shown = shownValue(record, name, hint, byName)}
        <dt class="text-base-content/65">{label(name, hint)}</dt>
        <dd><ViewValue value={shown.value} {hint} type={shown.type} block /></dd>
      {/each}
    </dl>
    {#each view.panels ?? [] as panel, i (i)}
      <div class="border-t border-base-200 pt-4">
        <ViewNode view={panel} {host} {record} />
      </div>
    {/each}
  {/if}
</div>
