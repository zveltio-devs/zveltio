<script lang="ts">
let {
    message = 'Loading...'
}: {
    message?: string;
} = $props();
</script>

<div class="flex flex-col items-center justify-center p-8">
    <span class="loading loading-spinner loading-lg"></span>
    {#if message}<p class="mt-4 text-sm opacity-60">{message}</p>{/if}
</div>