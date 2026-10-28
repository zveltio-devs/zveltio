<script lang="ts">
/**
 * The one dialog (`@zveltio/ui`), used by the Console, the App and extensions.
 *
 * What a dialog owes the person using it — Escape closes it, focus moves in on
 * open and cannot leave, focus returns to whatever opened it, the page behind
 * is inert to assistive tech and does not scroll — comes from `bits-ui`'s
 * dialog primitive (ADR 0007: daisyUI for the look, bits-ui for behaviour).
 * This file used to hand-roll the focus trap; it had two escape routes found
 * one review at a time, and no scroll lock at all.
 */
import { Dialog } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  children,
  open = $bindable(false),
  title = '',
  size = 'md',
  onClose = null,
  /** Set false for a dialog the user must answer (a destructive confirm). */
  dismissible = true,
  /**
   * Pass a submit handler and the body becomes a real <form>.
   *
   * What that buys, and why it is not cosmetic: Enter from any field submits,
   * which is what someone typing into a dialog expects; the browser runs
   * `required` and `type` checks before the handler; and a password manager can
   * recognise a credential form, which it cannot do without one.
   *
   * Named `onSubmit`, not `onsubmit`: Svelte 5 reads a lowercase `on*` on a
   * COMPONENT as an event attribute rather than a prop, so the handler never
   * arrives and the form silently never renders.
   *
   * Left off, the body renders without a form — a dialog whose fields apply as
   * they change has nothing to submit.
   */
  onSubmit = null,
  /** The close control's accessible name; the kit has no catalogue, the host translates. */
  closeLabel = 'Close',
}: {
  children: Snippet;
  open?: boolean;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  onClose?: (() => void) | null;
  dismissible?: boolean;
  onSubmit?: (() => void) | null;
  closeLabel?: string;
} = $props();

const sizes: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
};

// bits-ui reports only the person's own dismissals here (Escape, outside
// click, the close button) — never the host setting `open` itself — which is
// exactly when `onClose` has always fired.
function onOpenChange(next: boolean) {
  if (!next) onClose?.();
}

const behavior = $derived(dismissible ? 'close' : 'ignore');
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <div class="modal modal-open">
      <Dialog.Overlay class="modal-backdrop" />
      <Dialog.Content
        class="modal-box {sizes[size] ?? sizes.md}"
        aria-label={title ? undefined : closeLabel}
        escapeKeydownBehavior={behavior}
        interactOutsideBehavior={behavior}
      >
        {#if title}<Dialog.Title level={3} class="font-bold text-lg">{title}</Dialog.Title>{/if}
        {#if dismissible}
          <Dialog.Close class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" aria-label={closeLabel}
            >✕</Dialog.Close
          >
        {/if}
        {#if onSubmit}
          <form
            class="py-4"
            onsubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {@render children()}
          </form>
        {:else}
          <div class="py-4">{@render children()}</div>
        {/if}
      </Dialog.Content>
    </div>
  </Dialog.Portal>
</Dialog.Root>
