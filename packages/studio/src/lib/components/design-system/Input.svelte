<script lang="ts">
  let {
    value = $bindable(''),
    type = 'text',
    placeholder = '',
    label = '',
    error = '',
    helperText = '',
    size = 'md',
    readonly = false,
    class: className
  }: {
    value?: string;
    type?: string;
    placeholder?: string;
    label?: string;
    error?: string;
    helperText?: string;
    size?: 'sm' | 'md' | 'lg';
    readonly?: boolean;
    class?: string;
  } = $props();

  // Generate unique ID for input-label association
  let inputId = $state(`input-${Math.random().toString(36).substring(2, 9)}`);

  const sizes = {
    sm: 'input-sm',
    md: '',
    lg: 'input-lg'
  };

  const baseClasses = 'input w-full transition-all duration-200 focus:ring-2 focus:ring-primary focus:outline-none';
  const errorClasses = 'input-error border-error focus:border-error focus:ring-error/20';
  const successClasses = 'border-success focus:border-success focus:ring-success/20';
</script>

<div class="form-control w-full {className ?? ''}">
  {#if label}
    <label for={inputId} class="label text-sm font-medium">
      <span class="label-text text-base-content/80">{label}</span>
    </label>
  {/if}
  
  <div class="relative">
    <input 
      id={inputId}
      {type} 
      bind:value 
      {placeholder} 
      {readonly}
      class="{baseClasses} {error ? errorClasses : successClasses} {sizes[size]}"
    />
  </div>
  
  <div class="flex justify-between items-center mt-1 min-h-4">
    {#if error}
      <label for={inputId} class="label">
        <span class="label-text-alt text-error text-xs">{error}</span>
      </label>
    {/if}
    {#if helperText && !error}
      <label for={inputId} class="label">
        <span class="label-text-alt text-base-content/60 text-xs">{helperText}</span>
      </label>
    {/if}
  </div>
</div>