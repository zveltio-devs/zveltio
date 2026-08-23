<script lang="ts">
  let { title = '', subtitle = '', cta_text = '', cta_url = '', image_url = '' } = $props();
</script>

<div class="hero min-h-[50vh] bg-base-200">
  <div class="hero-content flex-col lg:flex-row-reverse">
    {#if image_url}
      <img src={image_url} alt={title} class="max-w-sm rounded-lg shadow-2xl" />
    {/if}
    <div>
      <h1 class="text-5xl font-bold">{title}</h1>
      {#if subtitle}<p class="py-6">{subtitle}</p>{/if}
      {#if cta_text}<a href={cta_url} class="btn btn-primary">{cta_text}</a>{/if}
    </div>
  </div>
</div>
