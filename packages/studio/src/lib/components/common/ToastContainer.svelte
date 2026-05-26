<script lang="ts">
/**
 * Toast renderer — place once in admin +layout.svelte.
 *
 *   import { toast } from '$lib/stores/toast.svelte.js';
 *   toast.success('Saved!');
 *   toast.undoable('Deleted webhook', { onUndo: () => restore() });
 *
 * Uses Svelte's `fly` transition for spring-like enter from the right.
 * If a toast carries an action (e.g. Undo), the button renders inline
 * — clicking it runs the handler AND dismisses the toast.
 */
import { toast, type Toast } from '$lib/stores/toast.svelte.js';
import { X } from '@lucide/svelte';
import { fly } from 'svelte/transition';
import { cubicOut } from 'svelte/easing';

const alertClass: Record<string, string> = {
  success: 'alert-success',
  error: 'alert-error',
  warning: 'alert-warning',
  info: 'alert-info',
};

const alertIcon: Record<string, string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

async function runAction(t: Toast) {
  if (!t.action) return;
  try {
    await t.action.handler();
  } finally {
    toast.remove(t.id);
  }
}
</script>

<div class="toast toast-end toast-bottom z-9999">
  {#each toast.items as t (t.id)}
    <div
      role="status"
      aria-live="polite"
      class="alert {alertClass[t.type]} shadow-z3 max-w-md rounded-2xl"
      in:fly={{ x: 60, duration: 320, easing: cubicOut, opacity: 0 }}
      out:fly={{ x: 60, duration: 200, opacity: 0 }}
    >
      <span class="text-lg font-bold shrink-0" aria-hidden="true">{alertIcon[t.type]}</span>
      <span class="text-sm flex-1">{t.message}</span>
      {#if t.action}
        <button
          class="btn btn-ghost btn-sm font-semibold"
          onclick={() => runAction(t)}
        >
          {t.action.label}
        </button>
      {/if}
      <button
        class="btn btn-ghost btn-xs btn-circle"
        onclick={() => toast.remove(t.id)}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  {/each}
</div>
