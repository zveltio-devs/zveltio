<script lang="ts">
/**
 * The twelve-column grid blocks are laid out on (`@zveltio/ui/blocks`); a
 * container is one nested inside another. The caller places each child with
 * `col-span-*` classes.
 */
import type { Snippet } from 'svelte';
import { GAPS, type Gap } from './grid.js';

let { gap = 'md', children }: { gap?: Gap; children: Snippet } = $props();
</script>

<div class={['grid grid-cols-12 items-start', GAPS[gap] ?? GAPS.md]}>
  {@render children()}
</div>
