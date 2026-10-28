<script lang="ts">
/**
 * The form for one record of any collection (`@zveltio/ui`, ADR 0007 item 3),
 * drawn from the fields this user may read. A new record sends what was filled
 * in; an existing one, only what changed. The host does the request: the kit
 * hands it the body. The kit has no catalogue: the host passes the words.
 */
import type { CollectionMeta, CollectionRecord } from './collection.js';
import Button from './Button.svelte';
import Field from './Field.svelte';
import { FieldValueError, fromInput, inputKind, isWritable, toInput } from './fields.js';

let {
  collection,
  record,
  onSave,
  onDelete = null,
  labels,
}: {
  collection: CollectionMeta;
  /** `null` for a new record. */
  record: CollectionRecord | null;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  /** Offered only for an existing record; the host confirms. */
  onDelete?: (() => Promise<void>) | null;
  labels: {
    save: string;
    saving: string;
    delete: string;
    notANumber: (field: string) => string;
    invalidJson: (field: string) => string;
  };
} = $props();

const fields = $derived(
  collection.fields.map((f) => ({ ...f, kind: inputKind(f.type), writable: isWritable(f) })),
);

/** The inputs, seeded from the record each time the host passes one. */
let values = $state<Record<string, string | boolean>>({});
$effect(() => {
  values = Object.fromEntries(fields.map((f) => [f.name, toInput(f.kind, record?.[f.name])]));
});
let saving = $state(false);
let problem = $state<string | null>(null);

function message(err: unknown): string {
  if (err instanceof FieldValueError)
    return err.reason === 'number' ? labels.notANumber(err.field) : labels.invalidJson(err.field);
  return err instanceof Error ? err.message : String(err);
}

async function save(e: SubmitEvent) {
  e.preventDefault();
  saving = true;
  problem = null;
  try {
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      if (!f.writable) continue;
      const value = fromInput(f.kind, values[f.name] ?? '', f.name);
      const before = record ? fromInput(f.kind, toInput(f.kind, record[f.name]), f.name) : null;
      if (JSON.stringify(value) !== JSON.stringify(before)) body[f.name] = value;
    }
    await onSave(body);
  } catch (err) {
    problem = message(err);
  } finally {
    saving = false;
  }
}

async function remove() {
  problem = null;
  try {
    await onDelete?.();
  } catch (err) {
    problem = message(err);
  }
}
</script>

{#if problem}<div role="alert" class="alert alert-error">{problem}</div>{/if}

<form onsubmit={save} class="card bg-base-100 shadow">
  <div class="card-body gap-3">
    {#each fields as f (f.name)}
      {@const id = `f-${f.name}`}
      {#if f.kind === 'checkbox'}
        <label class="label gap-2" for={id}>
          <input {id} type="checkbox" class="checkbox" disabled={!f.writable} bind:checked={values[f.name] as boolean} />
          {f.label ?? f.name}
        </label>
      {:else}
        <Field label={f.label ?? f.name} hint={f.description ?? ''} required={f.required}>
          {#snippet control({ id, describedby, required })}
            {#if f.kind === 'textarea' || f.kind === 'json'}
              <textarea {id} aria-describedby={describedby} aria-required={required || undefined} class="textarea w-full" class:font-mono={f.kind === 'json'} rows="4"
                readonly={!f.writable} bind:value={values[f.name] as string}></textarea>
            {:else}
              <input {id} aria-describedby={describedby} aria-required={required || undefined} type={f.kind} step={f.kind === 'number' ? 'any' : f.kind === 'datetime-local' || f.kind === 'time' ? '1' : undefined} class="input w-full"
                readonly={!f.writable} required={f.required && f.writable && !record}
                bind:value={values[f.name] as string} />
            {/if}
          {/snippet}
        </Field>
      {/if}
    {/each}

    <div class="card-actions justify-between mt-2">
      {#if record && onDelete}
        <Button variant="ghost" class="text-error" onclick={remove}>{labels.delete}</Button>
      {:else}<span></span>{/if}
      <Button type="submit" variant="primary" loading={saving}>{saving ? labels.saving : labels.save}</Button>
    </div>
  </div>
</form>
