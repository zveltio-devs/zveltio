<script lang="ts">
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { resolve } from '$app/paths';
import { onMount } from 'svelte';

onMount(() => {
  goto(resolve(`collections/${page.params.name}?tab=schema`), { replace: true });
});
</script>
