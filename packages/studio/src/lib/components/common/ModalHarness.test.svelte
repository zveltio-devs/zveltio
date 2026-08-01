<script lang="ts">
/**
 * Test-only wrapper.
 *
 * Modal takes a `children` snippet, and snippets cannot be constructed from a
 * plain props object in a component test. This gives the tests a real dialog
 * body with focusable elements to trap focus between.
 */
import Modal from './Modal.svelte';

let {
  open = true,
  title = '',
  onClose = null,
  dismissible = true,
}: {
  open?: boolean;
  title?: string;
  onClose?: (() => void) | null;
  dismissible?: boolean;
} = $props();
</script>

<Modal bind:open {title} {onClose} {dismissible}>
  {#snippet children()}
    <input data-testid="first-field" placeholder="Name" />
    <button>Save</button>
    <input data-testid="last-field" placeholder="Notes" />
  {/snippet}
</Modal>
