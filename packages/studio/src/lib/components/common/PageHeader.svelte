<script lang="ts">
  interface Props {
    title: string;
    subtitle?: string;
    count?: number | null;
  }
  let { title, subtitle, count } = $props<Props>();
</script>

<div class="flex items-start justify-between gap-4 mb-6">
  <div>
    <div class="flex items-center gap-2.5">
      <h1 class="text-xl font-semibold text-base-content">{title}</h1>
      {#if count !== undefined && count !== null}
        <span class="badge badge-ghost badge-sm font-mono">{count.toLocaleString()}</span>
      {/if}
    </div>
    {#if subtitle}
      <p class="text-sm text-base-content/50 mt-0.5">{subtitle}</p>
    {/if}
  </div>
  <slot />
</div>
