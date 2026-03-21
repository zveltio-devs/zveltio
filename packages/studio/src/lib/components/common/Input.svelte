<script lang="ts">
let {
    value = $bindable(''),
    type = 'text',
    placeholder = '',
    label = '',
    error = ''
}: {
    value?: string;
    type?: string;
    placeholder?: string;
    label?: string;
    error?: string;
} = $props();
</script>

<div class="form-control w-full">
    {#if label}<label class="label"><span class="label-text">{label}</span></label>{/if}
    <input {type} bind:value {placeholder} class="input input-bordered {error ? 'input-error' : ''}" />
    {#if error}<label class="label"><span class="label-text-alt text-error">{error}</span></label>{/if}
</div>