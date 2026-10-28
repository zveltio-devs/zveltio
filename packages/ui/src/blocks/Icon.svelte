<script lang="ts">
/**
 * One stroke icon (`@zveltio/ui/blocks`) from an SVG path. Decorative unless
 * it has a `label`, which is then its accessible name and shows beside it.
 */
let {
  path,
  size = 32,
  color = '',
  label = '',
}: { path: string; size?: number; color?: string; label?: string } = $props();
</script>

<span class="inline-flex items-center gap-2">
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || 'currentColor'}
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    role={label ? 'img' : 'presentation'}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : 'true'}><path d={path} /></svg>
  {#if label}<span aria-hidden="true">{label}</span>{/if}
</span>
