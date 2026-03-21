<script lang="ts">
let {
    href,
    label,
    icon = null,
    active = false
}: {
    href: string;
    label: string;
    icon?: any;
    active?: boolean;
} = $props();
</script>

<a {href} class="btn btn-ghost {active ? 'btn-active' : ''}">
    {#if icon}<svelte:component this={icon} size={16} />{/if}
    <span>{label}</span>
</a>