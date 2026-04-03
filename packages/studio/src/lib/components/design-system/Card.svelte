<script lang="ts">
  let {
    children,
    title,
    subtitle,
    action,
    padding = 'p-6',
    class: className,
    ...props
  }: {
    children?: any;
    title?: string;
    subtitle?: string;
    action?: any;
    padding?: string;
    class?: string;
  } = $props();
</script>

<div class="card bg-base-200 shadow-sm hover:shadow-md transition-all duration-200 {className ?? ''} {padding}" {...props}>
  {#if title}
    <div class="flex items-center justify-between mb-4">
      <div>
        <h3 class="card-title text-lg font-semibold text-base-content">{title}</h3>
        {#if subtitle}
          <p class="text-sm text-base-content/60 mt-1">{subtitle}</p>
        {/if}
      </div>
      {#if action}
        <div class="flex items-center gap-2">
          {@render action()}
        </div>
      {/if}
    </div>
  {/if}
  
  <div class="flex-1">
    {@render children()}
  </div>
</div>