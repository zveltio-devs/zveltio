<script lang="ts">
 type FormFieldType = 'text' | 'email' | 'number' | 'textarea' | 'select' | 'boolean' | 'lookup';

 type FormFieldOption = { value: any; label: string; };

 interface Props {
 key: string;
 label: string;
 type?: FormFieldType;
 value?: any;
 options?: FormFieldOption[];
 error?: string;
 placeholder?: string;
 required?: boolean;
 id?: string;
 }

 let {
 key,
 label,
 type = 'text',
 value = $bindable(),
 options = [],
 error = '',
 placeholder = '',
 required = false,
 id = 'field-' + Math.random().toString(36).slice(2),
 }: Props = $props();
</script>

<div class="form-control">
 <label class="label" for={id}>
 <span class="label-text">{label}{required ? ' *' : ''}</span>
 </label>

 {#if type === 'text' || type === 'email' || type === 'number'}
 <input
 {id} {type}
 bind:value
 {placeholder}
 class="input {error ? 'input-error' : ''}"
 />
 {:else if type === 'textarea'}
 <textarea
 {id}
 bind:value
 {placeholder}
 class="textarea {error ? 'textarea-error' : ''}"
 rows="4"
 ></textarea>
 {:else if type === 'select'}
 <select {id} bind:value class="select {error ? 'select-error' : ''}">
 <option value="">— Select —</option>
 {#each options as opt}
 <option value={opt.value}>{opt.label}</option>
 {/each}
 </select>
 {:else if type === 'boolean'}
 <label class="flex items-center gap-2 cursor-pointer mt-1">
 <input {id} type="checkbox" bind:checked={value} class="checkbox" />
 <span class="text-sm">{value ? 'Yes' : 'No'}</span>
 </label>
 {/if}

 {#if error}
 <label class="label" for={id}>
 <span class="label-text-alt text-error">{error}</span>
 </label>
 {/if}
</div>
