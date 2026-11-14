<script lang="ts">
import { m } from '#lib/i18n.svelte.js';
import KanbanBoard from '#lib/ext/projects/management/components/KanbanBoard.svelte';
</script>
<svelte:head><title>{m['projects.management.kanban.title']()}</title></svelte:head>
<div class="p-4 md:p-6 max-w-[90rem] mx-auto w-full"><KanbanBoard /></div>
