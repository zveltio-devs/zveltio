<script lang="ts">
/**
 * Confirmation modal.
 *
 * Used in 36 places, most of them destructive — `btn-error` is the default
 * confirm style. It looked finished and, to anyone not using a mouse, was not:
 *
 *  - nothing marked it as a dialog, so a screen reader announced no context
 *    change; the content simply appeared somewhere in the page;
 *  - the title and message were not associated with it, so neither was read as
 *    the dialog's name or description;
 *  - focus never moved into it. The confirm button had to be reached by tabbing
 *    forward through the page behind, which is also still reachable;
 *  - Escape was bound to the BACKDROP, a `role="button"` with `tabindex="0"`.
 *    Since focus never went there, Escape did nothing.
 *
 * So the fix is not one attribute. A dialog has to say what it is, name itself,
 * take focus, keep it, and give it back.
 */
import { fade, scale } from 'svelte/transition';
import { cubicOut } from 'svelte/easing';
import { m } from '$lib/i18n.svelte.js';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmClass?: string;
  onconfirm: () => void;
  oncancel: () => void;
}
let {
  open,
  title,
  message,
  confirmLabel = m['common.confirm'](),
  confirmClass = 'btn-error',
  onconfirm,
  oncancel,
}: Props = $props();

// Unique per instance: two confirmations can be mounted at once, and a
// duplicated id would point aria-labelledby at whichever rendered first.
const titleId = `confirm-title-${crypto.randomUUID().slice(0, 8)}`;
const messageId = `confirm-msg-${crypto.randomUUID().slice(0, 8)}`;

let box = $state<HTMLElement | null>(null);
let confirmBtn = $state<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

$effect(() => {
  if (!open) return;
  // Remember where focus was so it can go back — landing the user at the top of
  // the document after cancelling is its own small disorientation.
  previouslyFocused = document.activeElement as HTMLElement | null;
  // Focus the confirm action rather than the box: it is what the dialog is for,
  // and it is one Shift+Tab from Cancel either way.
  queueMicrotask(() => confirmBtn?.focus());
  return () => previouslyFocused?.focus?.();
});

/** Escape closes, and Tab cannot leave. */
function onDialogKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    oncancel();
    return;
  }
  if (e.key !== 'Tab' || !box) return;
  const focusable = box.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

{#if open}
  <div class="modal modal-open z-50">
    <div
      bind:this={box}
      class="modal-box max-w-md shadow-z3 border-0 rounded-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      tabindex="-1"
      onkeydown={onDialogKey}
      transition:scale={{ start: 0.96, duration: 180, easing: cubicOut, opacity: 0 }}
    >
      <h3 id={titleId} class="font-bold text-lg tracking-tight">{title}</h3>
      <p id={messageId} class="py-4 text-sm text-base-content/65 leading-relaxed">{message}</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>{m['common.cancel']()}</button>
        <button
          bind:this={confirmBtn}
          type="button"
          class="btn {confirmClass} btn-sm shadow-z1"
          onclick={onconfirm}>{confirmLabel}</button
        >
      </div>
    </div>
    <!--
      The backdrop stays clickable and stays out of the tab order. It was
      `role="button" tabindex="0"` so that it could carry the Escape handler;
      Escape belongs on the dialog now, and a focusable backdrop only gave a
      keyboard user somewhere useless to land.
    -->
    <button
      type="button"
      class="modal-backdrop bg-base-content/20 backdrop-blur-md"
      tabindex="-1"
      aria-hidden="true"
      onclick={oncancel}
      transition:fade={{ duration: 150 }}
    ></button>
  </div>
{/if}
