<script lang="ts">
import type { Component } from 'svelte';

let {
    href,
    label,
    icon,
    active = false
}: {
    href: string;
    label: string;
    icon?: Component<{ size?: number }>;
    active?: boolean;
} = $props();

// Svelte 5 runes treat component values as first-class — call them
// like any other tag. `<svelte:component>` is deprecated and will be
// removed in a future major.
const Icon = $derived(icon);
</script>

<a {href} class="btn btn-ghost {active ? 'btn-active' : ''}">
    {#if Icon}<Icon size={16} />{/if}
    <span>{label}</span>
</a>