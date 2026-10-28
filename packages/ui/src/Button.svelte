<script lang="ts">
/**
 * A button (`@zveltio/ui`). `loading` disables it and says so to assistive
 * tech, so a slow save cannot be submitted twice.
 */
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';

let {
  variant = 'default',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  children,
  ...rest
}: HTMLButtonAttributes & {
  variant?: 'default' | 'primary' | 'secondary' | 'ghost' | 'outline' | 'error';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
  children: Snippet;
} = $props();

const variants: Record<string, string> = {
  default: '',
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  outline: 'btn-outline',
  error: 'btn-error',
};
const sizes: Record<string, string> = { xs: 'btn-xs', sm: 'btn-sm', md: '', lg: 'btn-lg' };
</script>

<button
  {...rest}
  {type}
  class="btn {variants[variant]} {sizes[size]} {rest.class ?? ''}"
  disabled={disabled || loading}
  aria-busy={loading || undefined}
>
  {#if loading}<span class="loading loading-spinner loading-xs" aria-hidden="true"></span>{/if}
  {@render children()}
</button>
