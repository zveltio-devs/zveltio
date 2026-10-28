<script lang="ts">
/** Vertical space (`@zveltio/ui/blocks`), in pixels. */
let { height = 48 }: { height?: number } = $props();
</script>

<div aria-hidden="true" style:height="{Number(height) > 0 ? Number(height) : 48}px"></div>
