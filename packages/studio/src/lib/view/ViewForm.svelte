<script lang="ts">
/**
 * `form`: create or edit a record through the data API, or fill an action's
 * input and run it. The fields, their types and labels come from the
 * collection (or the action's input schema); the view only selects and orders.
 */
import {
  type FormView,
  isEditable,
  resolveValue,
  type SchemaField,
  viewFields,
  type ViewScope,
} from '@zveltio/sdk/view';
import type { FormField } from '@zveltio/sdk/extension';
import { m } from '#lib/i18n.svelte.js';
import { dataApi } from '#lib/api.js';
import { toast } from '#lib/stores/toast.svelte.js';
import SchemaForm from '#lib/components/common/SchemaForm.svelte';
import {
  actionInputFields,
  fieldHints,
  findAction,
  formPayload,
  runnableActions,
  schemaOf,
  toFormField,
  type ViewHost,
} from './engine.js';
import ViewButtons from './ViewButtons.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: FormView;
  host: ViewHost;
  scope: ViewScope;
  /** After a save (the create dialog of a list closes on it). */
  onDone?: () => void;
}
const { view, host, scope, onDone }: Props = $props();

let schema = $state<SchemaField[]>([]);
let values = $state<Record<string, unknown>>({});
let recordId = $state<string | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let saving = $state(false);

const collection = $derived('collection' in view ? view.collection : null);
/** `undefined`: a reference with no value yet (no row selected). */
const target = $derived.by<string | null | undefined | 'singleton'>(() => {
  if (!('collection' in view) || view.record === undefined) return null;
  if (view.record === 'singleton') return 'singleton';
  const id = resolveValue(view.record, scope);
  return id === undefined || id === null ? undefined : String(id);
});

let seq = 0;
$effect(() => {
  const t = target;
  const c = collection;
  void host.version;
  const mine = ++seq;
  loading = true;
  error = null;
  const fields = c
    ? schemaOf(c)
    : runnableActions().then((list) =>
        actionInputFields(findAction(list, host.ext, (view as { action: string }).action)?.input),
      );
  const record =
    !c || t === null || t === undefined
      ? Promise.resolve(null)
      : t === 'singleton'
        ? dataApi.list(c, { limit: 1 }).then((r) => r.records[0] ?? null)
        : dataApi.get(c, t);
  Promise.all([fields, record])
    .then(([f, r]) => {
      // A newer target is already loading: this answer is for a record no longer shown.
      if (mine !== seq) return;
      schema = f;
      recordId = r?.id ?? null;
      values = r ? { ...r } : {};
    })
    .catch((e: Error) => {
      if (mine === seq) error = e.message || m['ext.loadFailed']();
    })
    .finally(() => {
      if (mine === seq) loading = false;
    });
});

const hints = $derived(new Map(fieldHints(view.fields ?? []).map((h) => [h.name, h.hint])));
const byName = $derived(new Map(schema.map((f) => [f.name, f])));
const groups = $derived(
  view.sections?.length
    ? view.sections.map((s) => ({ title: s.title, fields: fieldHints(s.fields) }))
    : [{ title: undefined, fields: fieldHints(viewFields(view.fields, schema, 'form')) }],
);
/** Whether a field of the view is shown as text: the view says so, or the engine does. */
const shownOnly = (name: string, hint: { readOnly?: boolean } | null) =>
  !!hint?.readOnly || (byName.has(name) && !isEditable(byName.get(name)!));
/** Editable fields, as `SchemaForm` draws them, per section. A view naming a
 * system, computed or read-only field shows it; it never makes it writable. */
const editable = $derived(
  groups.map((g) =>
    g.fields
      .filter(({ name, hint }) => byName.has(name) && !shownOnly(name, hint))
      .map(({ name, hint }) =>
        toFormField(byName.get(name)!, hint?.label ? host.t(hint.label) : undefined),
      ),
  ),
);
const allEditable = $derived(editable.flat() as FormField[]);
const notDrawn = $derived(
  [view.lines && 'lines', view.recalc && 'recalc', view.autosave && 'autosave'].filter(
    Boolean,
  ) as string[],
);

async function save() {
  saving = true;
  try {
    if (!collection) {
      await host.run((view as { action: string }).action, formPayload(values, allEditable));
    } else {
      const body = formPayload(values, allEditable, recordId !== null);
      if (recordId) await dataApi.update(collection, recordId, body);
      else await dataApi.create(collection, body);
      toast.success(m['common.saved']());
      host.version++;
    }
    onDone?.();
  } catch (e) {
    toast.error((e as Error).message || m['common.saveFailed']());
  } finally {
    saving = false;
  }
}
</script>

<div class="space-y-4" data-testid="view-form">
  {#each notDrawn as kind (kind)}
    <div class="alert alert-info text-sm">{m['view.notDrawn']({ kind })}</div>
  {/each}
  {#if target === undefined}
    <p class="text-sm text-base-content/65 py-6 text-center">{m['view.selectFirst']()}</p>
  {:else if loading}
    <span class="loading loading-spinner loading-sm"></span>
  {:else if error}
    <div class="alert alert-error text-sm">{error}</div>
  {:else}
    {#each groups as group, gi (gi)}
      <section class="space-y-2">
        {#if group.title}<h3 class="font-semibold text-sm">{host.t(group.title)}</h3>{/if}
        {#each group.fields.filter((f) => shownOnly(f.name, f.hint)) as { name, hint } (name)}
          <div class="text-sm">
            <span class="text-base-content/65">{hint?.label ? host.t(hint.label) : name}:</span>
            <ViewValue value={values[name]} {hint} type={byName.get(name)?.type} />
          </div>
        {/each}
        <SchemaForm
          formId={`view:${host.ext}:${view.id ?? collection ?? (view as { action: string }).action}:${gi}`}
          schema={{ id: `view:${host.ext}`, fields: editable[gi] }}
          bind:values
        />
      </section>
    {/each}
    <div class="flex justify-end gap-2">
      {#if view.submit?.length}
        <ViewButtons
          buttons={view.submit}
          {host}
          scope={{ ...scope, record: { ...values, ...(recordId ? { id: recordId } : {}) } }}
          onSave={save}
        />
      {:else}
        <button class="btn btn-primary btn-sm" disabled={saving} onclick={save}>
          {m['common.save']()}
        </button>
      {/if}
    </div>
  {/if}
</div>
