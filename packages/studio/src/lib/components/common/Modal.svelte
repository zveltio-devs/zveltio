<script lang="ts">
/**
 * The one modal.
 *
 * This component existed with zero importers while thirteen route files wrote
 * their own `<dialog>` — and it would not have been worth adopting anyway: no
 * Escape handling, no focus trap, no `aria-modal`. A keyboard user could tab
 * out of an open dialog into the page behind it, and a screen reader was never
 * told the rest of the page was inert.
 *
 * What a dialog owes the person using it:
 *   - Escape closes it, wherever focus happens to be;
 *   - focus moves INTO it on open and cannot leave while it is open;
 *   - focus returns to whatever opened it on close, so the keyboard does not
 *     jump back to the top of the document;
 *   - `aria-modal` + `role="dialog"` so assistive tech treats the rest as inert.
 *
 * The backdrop stays a <button> rather than a click handler on a div: it is
 * genuinely actionable, and making it a real control is what puts it in the tab
 * order and gives it a name.
 */
import type { Snippet } from 'svelte';
import { m } from '$lib/i18n.svelte.js';

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
   * which is what someone typing into a dialog expects and what every one of
   * these dialogs was missing; the browser runs `required` and `type` checks
   * before the handler; and a password manager can recognise a credential form,
   * which it cannot do without one.
   *
   * Named `onSubmit`, not `onsubmit`: Svelte 5 reads a lowercase `on*` on a
   * COMPONENT as an event attribute rather than a prop, so the handler never
   * arrives and the form silently never renders.
   *
   * Left off, the body renders exactly as before — a dialog whose fields apply
   * as they change has nothing to submit, and wrapping it would invent a
   * submission that does not exist.
   */
  onSubmit = null,
}: {
  children: Snippet;
  open?: boolean;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  onClose?: (() => void) | null;
  dismissible?: boolean;
  onSubmit?: (() => void) | null;
} = $props();

const sizes: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
};

let box = $state<HTMLElement | null>(null);
let restoreTo: HTMLElement | null = null;

function close() {
  if (!dismissible) return;
  open = false;
  onClose?.();
}

/** Everything focusable inside the box, in document order. */
function focusables(): HTMLElement[] {
  if (!box) return [];
  return [
    ...box.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.offsetParent !== null);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  if (e.key !== 'Tab') return;

  // The trap. Without it, Tab walks out of the dialog and into the page behind
  // it, which is still rendered — the user is then editing something they
  // cannot see.
  const items = focusables();
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;

  if (e.shiftKey && (active === first || !box?.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

$effect(() => {
  if (!open) return;
  // Remember where focus came from BEFORE moving it, so closing returns the
  // keyboard to the button that opened the dialog rather than the document top.
  restoreTo = document.activeElement as HTMLElement | null;
  // Wait a tick so the box is in the DOM.
  queueMicrotask(() => {
    const items = focusables();
    (items[0] ?? box)?.focus();
  });
  return () => restoreTo?.focus?.();
});
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
  <!-- `open` is not decoration: a <dialog> without it is display:none per the UA
       stylesheet and absent from the accessibility tree. DaisyUI's `modal-open`
       overrides the display in CSS, so the dialog looks open to a sighted user
       and does not exist for a screen reader. -->
  <dialog open class="modal modal-open" role="dialog" aria-modal="true" aria-label={title || undefined}>
    <div class="modal-box {sizes[size] ?? sizes.md}" bind:this={box} tabindex="-1">
      {#if title}<h3 class="font-bold text-lg">{title}</h3>{/if}
      {#if dismissible}
        <button
          class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2"
          onclick={close}
          aria-label={m['common.close']()}>✕</button
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
    </div>
    {#if dismissible}
      <button type="button" class="modal-backdrop" aria-label={m['common.close']()} onclick={close}></button>
    {/if}
  </dialog>
{/if}
