<script lang="ts">
/**
 * `form`: create or edit a record through the data API, or fill an action's
 * input and run it. The fields, their types and labels come from the
 * collection (or the action's input schema); the view only selects and orders.
 * A `richtext` field is edited by `ViewRichTextEditor`, a `file` field by
 * `ViewFiles`, after the group's other fields. On a collection form an action
 * in `submit` saves the record first and runs on the saved record. An action
 * input property that is a list of objects is drawn by `ViewLines`.
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
  actionInputLines,
  actionInputUndrawn,
  fieldHints,
  findAction,
  formPayload,
  runnableActions,
  schemaOf,
  toFormField,
  type InputLines,
  type ViewHost,
} from './engine.js';
import ViewButtons from './ViewButtons.svelte';
import ViewFiles from './ViewFiles.svelte';
import ViewLines from './ViewLines.svelte';
import ViewRichTextEditor from './ViewRichTextEditor.svelte';
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
let inputLines = $state<InputLines[]>([]);
let undrawn = $state<string[]>([]);
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
    ? schemaOf(c).then((f) => ({ f, lines: [] as InputLines[], undrawn: [] as string[] }))
    : runnableActions().then((list) => {
        const input = findAction(list, host.ext, (view as { action: string }).action)?.input;
        return {
          f: actionInputFields(input),
          lines: actionInputLines(input),
          undrawn: actionInputUndrawn(input),
        };
      });
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
      schema = f.f;
      inputLines = f.lines;
      undrawn = f.undrawn;
      recordId = r?.id ?? null;
      values = r
        ? { ...r }
        : Object.fromEntries(
            f.lines.map((l) => [l.name, Array.from({ length: Math.max(l.min, 1) }, () => ({}))]),
          );
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
/** Field types drawn here rather than by `SchemaForm`. */
const OWN_EDITOR = new Set(['richtext', 'file']);
const ownEditor = (f: FormField) => OWN_EDITOR.has(String(f.fieldType));
const multiple = (name: string) =>
  (byName.get(name)?.options as { multiple?: unknown } | null | undefined)?.multiple === true;
/** The view names fields: only the lines it names; it names none: every line. */
const named = $derived(
  new Map(
    fieldHints([...(view.fields ?? []), ...(view.sections ?? []).flatMap((s) => s.fields)]).map(
      (h) => [h.name, h.hint],
    ),
  ),
);
const shownLines = $derived(named.size ? inputLines.filter((l) => named.has(l.name)) : inputLines);
const lineLabel = (l: InputLines) => {
  const label = named.get(l.name)?.label;
  return label ? host.t(label) : (l.label ?? l.name);
};
/** The drawn lines as the action takes them: a line with nothing filled in is dropped. */
const linesPayload = () =>
  Object.fromEntries(
    shownLines.map((l) => [
      l.name,
      ((values[l.name] as Record<string, unknown>[] | undefined) ?? []).filter(
        (r) => Object.keys(r).length > 0,
      ),
    ]),
  );
/** The first table of lines with too few filled lines or a required cell left empty. */
const unfilledLines = (body: Record<string, unknown>) =>
  shownLines.find((l) => {
    const rows = body[l.name] as Record<string, unknown>[];
    const required = l.columns.filter((c) => c.required).map((c) => c.name);
    return rows.length < l.min || rows.some((r) => required.some((n) => !Object.hasOwn(r, n)));
  });
const notDrawn = $derived([
  ...([view.lines && 'lines', view.recalc && 'recalc', view.autosave && 'autosave'].filter(
    Boolean,
  ) as string[]),
  ...undrawn,
]);

/** Saves the form; the record as saved, or `null` when it was refused. */
async function save(): Promise<Record<string, unknown> | null> {
  saving = true;
  try {
    let saved: Record<string, unknown> = { ...values };
    if (!collection) {
      const lines = linesPayload();
      const unfilled = unfilledLines(lines);
      if (unfilled) {
        toast.error(`${lineLabel(unfilled)}: ${m['common.required']()}`);
        return null;
      }
      await host.run((view as { action: string }).action, {
        ...formPayload(values, allEditable),
        ...lines,
      });
    } else {
      const body = formPayload(values, allEditable, recordId !== null);
      saved = recordId
        ? await dataApi.update(collection, recordId, body)
        : await dataApi.create(collection, body);
      if (saved?.id) recordId = String(saved.id);
      toast.success(m['common.saved']());
      host.version++;
    }
    onDone?.();
    return { ...values, ...saved };
  } catch (e) {
    toast.error((e as Error).message || m['common.saveFailed']());
    return null;
  } finally {
    saving = false;
  }
}

/** An action in a collection form's `submit` runs on the record as saved. */
async function beforeAction(scope: ViewScope): Promise<ViewScope | null> {
  if (!collection) return scope;
  const saved = await save();
  return saved && { ...scope, record: saved };
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
          schema={{ id: `view:${host.ext}`, fields: editable[gi].filter((f) => !ownEditor(f)) }}
          bind:values
        />
        {#each editable[gi].filter(ownEditor) as f (f.name)}
          {@const fid = `view-${host.ext}-${gi}-${f.name}`}
          <div class="form-control">
            <label class="label" for={fid}>
              <span class="label-text">
                {f.label}
                {#if f.required}<span class="text-error">*</span>{/if}
              </span>
            </label>
            {#if f.fieldType === 'richtext'}
              <ViewRichTextEditor
                id={fid}
                label={f.label ?? f.name}
                value={values[f.name]}
                onchange={(html) => (values[f.name] = html)}
              />
            {:else}
              <ViewFiles
                id={fid}
                value={values[f.name]}
                multiple={multiple(f.name)}
                onchange={(v) => (values[f.name] = v)}
              />
            {/if}
          </div>
        {/each}
      </section>
    {/each}
    {#each shownLines as l (l.name)}
      <ViewLines
        lines={l}
        label={lineLabel(l)}
        rows={(values[l.name] as Record<string, unknown>[] | undefined) ?? []}
        onchange={(rows) => (values[l.name] = rows)}
      />
    {/each}
    <div class="flex justify-end gap-2">
      {#if view.submit?.length}
        <ViewButtons
          buttons={view.submit}
          {host}
          scope={{ ...scope, record: { ...values, ...(recordId ? { id: recordId } : {}) } }}
          onSave={async () => void (await save())}
          {beforeAction}
        />
      {:else}
        <button class="btn btn-primary btn-sm" disabled={saving} onclick={save}>
          {m['common.save']()}
        </button>
      {/if}
    </div>
  {/if}
</div>
