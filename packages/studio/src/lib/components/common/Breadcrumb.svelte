<script lang="ts">
  interface Crumb {
    label: string;
    href?: string;
  }
  interface Props {
    crumbs: Crumb[];
    class?: string;
  }
  let { crumbs, class: className = '' }: Props = $props();
</script>

<div class="breadcrumbs text-sm {className}">
  <ul>
    {#each crumbs as crumb, i}
      <li>
        {#if crumb.href && i < crumbs.length - 1}
          <a href={crumb.href} class="text-base-content/60 hover:text-base-content">{crumb.label}</a>
        {:else}
          <span class="text-base-content font-medium">{crumb.label}</span>
        {/if}
      </li>
    {/each}
  </ul>
</div>
