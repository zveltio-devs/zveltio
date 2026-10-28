<script lang="ts">
/**
 * A labelled form field (`@zveltio/ui`). The control is the host's — any input,
 * select or textarea — and receives the ids that tie it to its label, hint and
 * error, so a screen reader announces all three and an error is not colour
 * alone.
 */
import type { Snippet } from 'svelte';

let {
  label,
  hint = '',
  error = '',
  required = false,
  control,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  control: Snippet<[{ id: string; describedby: string | undefined; invalid: boolean }]>;
} = $props();

const id = $props.id();
const describedby = $derived(
  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined,
);
</script>

<fieldset class="fieldset">
  <label class="fieldset-legend" for={id}>
    {label}{#if required}<span class="text-error" aria-hidden="true"> *</span>{/if}
  </label>
  {@render control({ id, describedby, invalid: !!error })}
  {#if hint}<p id="{id}-hint" class="label">{hint}</p>{/if}
  {#if error}<p id="{id}-error" class="label text-error" role="alert">{error}</p>{/if}
</fieldset>
