<script lang="ts">
/** A heading (`@zveltio/ui/blocks`), level 1 to 4. */
let { text, level = 2 }: { text: string; level?: 1 | 2 | 3 | 4 } = $props();
const tag = $derived(`h${[1, 2, 3, 4].includes(level) ? level : 2}`);
const size = $derived(level === 1 ? 'text-4xl sm:text-5xl' : level === 2 ? 'text-3xl' : 'text-2xl');
</script>

<svelte:element this={tag} class={['font-bold tracking-tight', size]}>{text}</svelte:element>
