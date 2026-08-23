<script lang="ts">
  let { title = '', items = [], columns = 3 } = $props();
</script>

<div class="py-12 px-4">
  {#if title}<h2 class="text-3xl font-bold text-center mb-8">{title}</h2>{/if}
  <div class="grid grid-cols-1 md:grid-cols-{columns} gap-6 max-w-6xl mx-auto">
    {#each items as item}
      <div class="card bg-base-100 shadow">
        <div class="card-body">
          {#if item.icon}<span class="text-3xl mb-2">{item.icon}</span>{/if}
          <h3 class="card-title">{item.title}</h3>
          <p class="text-base-content/70">{item.description}</p>
        </div>
      </div>
    {/each}
  </div>
</div>
