<!--
  Schema-driven form renderer (S3-02 closure).

  Lightweight Form component that consumes a `FormSchema` and applies any
  registered form-alter hooks before rendering. The output is a flat list
  of native daisyUI form fields — no fancy layout, no nested groups,
  intentionally minimal. Pages with bespoke layouts keep their own
  templates; pages that just need "render this set of inputs" use this.

  Why this exists in core (not just a pattern extensions can copy):
  - Centralizes the alter pipeline: one place reads
    `studioApi.applyFormAlters(formId, schema, ctx)`, every host gets
    extension contributions for free.
  - Stable wiring contract: as long as a host emits a `formId` and a
    schema, every extension form-alter hook fires correctly.

  Usage:

    <SchemaForm
      formId="core:user-invite"
      schema={{
        id: 'core:user-invite',
        fields: [
          { name: 'email', type: 'email', label: 'Email', required: true },
          { name: 'role',  type: 'select', label: 'Role',
            options: [{ value: 'member', label: 'Member' }, ...] },
        ],
      }}
      bind:values={form}
      ctx={{ user: auth.user, mode: 'create' }}
    />

  Fields supported (matches the FormField shape in @zveltio/sdk/extension):
  - text, email, tel, url, password, number → `<input type="...">`
  - textarea                                 → `<textarea>`
  - select                                   → `<select>` with `options`
  - checkbox                                 → `<input type="checkbox">`
  - hidden                                   → no markup, value preserved

  Unknown types fall back to `text` with a console warning so an
  extension's `addField({ type: 'fancy' })` does not break the form;
  the field still renders + persists, just without specialized UI.
-->
<script lang="ts">
import type { FormSchema, FormField } from '@zveltio/sdk/extension';
import { studioApi } from '$lib/extension-api.svelte.js';

interface Props {
  /** Stable form id; form-alter hooks match against this. */
  formId: string;
  /** Schema BEFORE alters. The component applies them at render. */
  schema: FormSchema;
  /** Bound value record, keyed by field name. */
  values: Record<string, unknown>;
  /**
   * Optional context forwarded to form-alter hooks AND used for live
   * validation (validators receive the raw value). Typical shape:
   * `{ user, mode: 'create' | 'edit' }`.
   */
  ctx?: Record<string, unknown>;
  /** Optional: forwarded onto the wrapping <form>. */
  class?: string;
}

let { formId, schema, values = $bindable(), ctx = {}, class: cls = '' }: Props = $props();

// Apply alters at mount + on schema change. `studioApi.applyFormAlters`
// is idempotent — repeated calls with the same hook set produce the
// same result. Re-runs when extensions register late.
const altered = $derived(studioApi.applyFormAlters(formId, schema, ctx));

// Visible fields = altered minus hidden. Hidden fields still persist
// (server-side defaults apply) but don't render.
const visible = $derived(altered.fields.filter((f: FormField) => !f.hidden));

/** Per-field error messages computed from registered validators. */
let errors = $state<Record<string, string | null>>({});

function runValidators(field: FormField, value: unknown): string | null {
  for (const v of field.validators ?? []) {
    const err = v(value);
    if (err !== null) return err;
  }
  return null;
}

function onInput(field: FormField, value: unknown): void {
  values[field.name] = value;
  errors[field.name] = runValidators(field, value);
}

/** Coerce option entries into a stable {value, label} shape. */
function normalizeOptions(opts: FormField['options']): Array<{ value: string; label: string }> {
  if (!opts) return [];
  return opts.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
}

// Public: expose a `validateAll()` for the host's submit handler.
// Returns true when every field passes. Updates `errors` in place.
export function validateAll(): boolean {
  let ok = true;
  for (const f of altered.fields) {
    const e = runValidators(f, values[f.name]);
    errors[f.name] = e;
    if (e) ok = false;
  }
  return ok;
}
</script>

<div class={`space-y-3 ${cls}`}>
  {#each visible as field (field.name)}
    <div class="form-control">
      {#if field.type !== 'checkbox' && field.label}
        <label class="label" for={`field-${formId}-${field.name}`}>
          <span class="label-text">
            {field.label}
            {#if field.required}<span class="text-error">*</span>{/if}
          </span>
        </label>
      {/if}

      {#if ['text', 'email', 'tel', 'url', 'password', 'number'].includes(field.type)}
        <input
          id={`field-${formId}-${field.name}`}
          type={field.type as 'text' | 'email' | 'tel' | 'url' | 'password' | 'number'}
          class="input input-bordered w-full"
          class:input-error={errors[field.name]}
          required={field.required}
          placeholder={field.placeholder as string | undefined}
          value={values[field.name] ?? ''}
          oninput={(e) => onInput(field, (e.currentTarget as HTMLInputElement).value)}
        />
      {:else if field.type === 'textarea'}
        <textarea
          id={`field-${formId}-${field.name}`}
          class="textarea textarea-bordered w-full"
          class:textarea-error={errors[field.name]}
          required={field.required}
          placeholder={field.placeholder as string | undefined}
          value={values[field.name] ?? ''}
          oninput={(e) => onInput(field, (e.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      {:else if field.type === 'select'}
        <select
          id={`field-${formId}-${field.name}`}
          class="select select-bordered w-full"
          class:select-error={errors[field.name]}
          required={field.required}
          value={values[field.name] ?? ''}
          onchange={(e) => onInput(field, (e.currentTarget as HTMLSelectElement).value)}
        >
          {#each normalizeOptions(field.options) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      {:else if field.type === 'checkbox'}
        <label class="label cursor-pointer justify-start gap-3" for={`field-${formId}-${field.name}`}>
          <input
            id={`field-${formId}-${field.name}`}
            type="checkbox"
            class="checkbox"
            checked={Boolean(values[field.name])}
            onchange={(e) => onInput(field, (e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="label-text">{field.label ?? field.name}</span>
        </label>
      {:else if field.type !== 'hidden'}
        <!-- Unknown type: degrade to text input + warn (once). -->
        {(() => { console.warn(`[SchemaForm:${formId}] unknown field type "${field.type}" — rendering as text`); return ''; })()}
        <input
          id={`field-${formId}-${field.name}`}
          type="text"
          class="input input-bordered w-full"
          value={String(values[field.name] ?? '')}
          oninput={(e) => onInput(field, (e.currentTarget as HTMLInputElement).value)}
        />
      {/if}

      {#if errors[field.name]}
        <span class="label-text-alt text-error mt-1">{errors[field.name]}</span>
      {/if}
    </div>
  {/each}
</div>
