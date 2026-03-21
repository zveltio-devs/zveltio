<script lang="ts">
  import '../app.css';
  import OfflineBanner from '$components/common/OfflineBanner.svelte';

  let { children } = $props();
</script>

<OfflineBanner />

{@render children()}
