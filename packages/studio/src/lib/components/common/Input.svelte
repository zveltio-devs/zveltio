<script lang="ts">
let {
  value = $bindable(''),
  type = 'text',
  placeholder = '',
  label = '',
  error = '',
}: {
  value?: string;
  type?: string;
  placeholder?: string;
  label?: string;
  error?: string;
} = $props();

// A generated id so the label can name the control it labels. Without the
// `for`/`id` pair a screen reader reads the field as unlabelled and a click on
// the label does not focus it — and this component is used across the Studio,
// so the miss multiplied.
const id = $props.id();
</script>

<div class="form-control w-full">
    {#if label}<label class="label" for={id}><span class="label-text">{label}</span></label>{/if}
    <input {id} {type} bind:value {placeholder} aria-describedby={error ? `${id}-error` : undefined} class="input input-bordered {error ? 'input-error' : ''}" />
    {#if error}<p class="label" id={`${id}-error`}><span class="label-text-alt text-error">{error}</span></p>{/if}
</div>