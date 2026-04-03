<script lang="ts">
  let {
    children,
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    onclick,
    class: className,
    ...props
  }: {
    children?: any;
    variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
    size?: 'xs' | 'sm' | 'md' | 'lg';
    disabled?: boolean;
    loading?: boolean;
    onclick?: () => void;
    class?: string;
  } = $props();

  const baseStyles = 'inline-flex items-center justify-center font-medium transition-all duration-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
  
  const variants = {
    primary: 'bg-primary text-primary-content hover:bg-primary-dark focus:ring-primary shadow-sm hover:shadow-md',
    secondary: 'bg-secondary text-secondary-content hover:bg-secondary-dark focus:ring-secondary shadow-sm',
    outline: 'border border-base-300 dark:border-base-700 text-base-content hover:bg-base-200 dark:hover:bg-base-800 focus:ring-primary',
    ghost: 'text-base-content hover:bg-base-200 dark:hover:bg-base-800',
    danger: 'bg-error text-error-content hover:bg-error-dark focus:ring-error'
  };

  const sizes = {
    xs: 'px-2 py-0.5 text-xs gap-1',
    sm: 'px-3 py-1.5 text-sm gap-1.5',
    md: 'px-4 py-2 text-base gap-2',
    lg: 'px-6 py-3 text-lg gap-2.5'
  };

  const loadingClass = 'animate-spin mr-2';
</script>

  <button
    class="{baseStyles} {variants[variant]} {sizes[size]} {className ?? ''}"
    disabled="{disabled || loading}"
    onclick="{onclick}"
    {...props}
  >
  {#if loading}
    <span class="loading loading-spinner loading-xs {loadingClass}"></span>
  {/if}
  {@render children()}
</button>
