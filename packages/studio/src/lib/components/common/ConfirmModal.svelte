<script lang="ts">
/**
 * Confirmation modal — refreshed for 2026.
 *
 * Glass-morphism backdrop with `backdrop-blur-md` over `bg-black/30`,
 * not the old solid `bg-black/40`. Modal box uses shadow-z3 instead
 * of the default daisyUI border.
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

function onBackdropKey(e: KeyboardEvent) {
  if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    oncancel();
  }
}
</script>

{#if open}
  <div class="modal modal-open z-50">
    <div
      class="modal-box max-w-md shadow-z3 border-0 rounded-2xl"
      transition:scale={{ start: 0.96, duration: 180, easing: cubicOut, opacity: 0 }}
    >
      <h3 class="font-bold text-lg tracking-tight">{title}</h3>
      <p class="py-4 text-sm text-base-content/65 leading-relaxed">{message}</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={oncancel}>{m['common.cancel']()}</button>
        <button class="btn {confirmClass} btn-sm shadow-z1" onclick={onconfirm}>{confirmLabel}</button>
      </div>
    </div>
    <div
      class="modal-backdrop bg-base-content/20 backdrop-blur-md"
      role="button"
      tabindex="0"
      aria-label="Close"
      onclick={oncancel}
      onkeydown={onBackdropKey}
      transition:fade={{ duration: 150 }}
    ></div>
  </div>
{/if}
