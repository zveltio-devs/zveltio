<script lang="ts">
  let { title = '', subtitle = '', button_text = '', button_url = '' } = $props();
</script>

<div class="bg-primary text-primary-content py-16 px-4 text-center">
  <h2 class="text-3xl font-bold">{title}</h2>
  {#if subtitle}<p class="mt-4 text-lg opacity-90">{subtitle}</p>{/if}
  {#if button_text}<a href={button_url} class="btn btn-secondary mt-6">{button_text}</a>{/if}
</div>
