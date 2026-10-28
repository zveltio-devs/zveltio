<script lang="ts">
/** A horizontal rule (`@zveltio/ui/blocks`). */
let { thickness = 0, color = '' }: { thickness?: number; color?: string } = $props();
</script>

<hr
  class="border-base-300"
  style:border-top-width={thickness > 0 ? `${thickness}px` : undefined}
  style:border-color={color || undefined}
/>
