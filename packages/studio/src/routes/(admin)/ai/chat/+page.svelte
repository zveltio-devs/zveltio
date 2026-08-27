<script lang="ts">
import ChatWorkspace from '$lib/ext/ai/components/ChatWorkspace.svelte';
import { m } from '$lib/i18n.svelte.js';
</script>

<svelte:head>
  <title>{m['nav.aiChat']()}</title>
</svelte:head>

<div class="p-4 md:p-6 max-w-6xl mx-auto w-full">
  <ChatWorkspace />
</div>
