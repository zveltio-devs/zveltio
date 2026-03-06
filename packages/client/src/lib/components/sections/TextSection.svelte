<script lang="ts">
  let { content = '', align = 'left' } = $props();
</script>

<div class="max-w-3xl mx-auto py-12 px-4 prose" style:text-align={align}>
  {@html content}
</div>
