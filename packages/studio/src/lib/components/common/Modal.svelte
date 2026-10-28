<script lang="ts">
/** The kit's dialog (`@zveltio/ui/Dialog.svelte`) with the Studio's words. */
import Dialog from '@zveltio/ui/Dialog.svelte';
import type { ComponentProps } from 'svelte';
import { m } from '#lib/i18n.svelte.js';

let { open = $bindable(false), children, ...rest }: ComponentProps<typeof Dialog> = $props();
</script>

<Dialog bind:open closeLabel={m['common.close']()} {...rest}>{@render children()}</Dialog>
