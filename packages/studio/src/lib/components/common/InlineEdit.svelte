<script lang="ts">
/**
 * Inline text editor — click (or focus + Enter) on a value to edit it
 * in place. Save on blur or Enter; Cancel on Escape.
 *
 * Designed for table cells and detail fields where opening a modal
 * or full edit form is overkill for a one-field change. Caller owns
 * persistence (the `onsave` callback) — this component only manages
 * the local edit/display swap.
 *
 * The pattern:
 *   1. Idle: render value as text, with a subtle dotted underline on
 *      hover hinting it's editable.
 *   2. Editing: render an <input> filled with the current value,
 *      auto-focused + auto-selected.
 *   3. Save: blur → `onsave(newValue)`; show spinner while pending;
 *      surface errors inline (red border + tooltip).
 *
 * Accessibility:
 *   - The display value is a `<button>` so keyboard users can tab to
 *     it and press Enter/Space to enter edit mode.
 *   - aria-live="polite" on the wrapper announces save state changes.
 */
import { LoaderCircle, Check, X } from '@lucide/svelte';

interface Props {
  value: string;
  /** Optional placeholder when the value is empty. */
  placeholder?: string;
  /** Caller-owned save handler. Should return a promise — the component
   *  shows a spinner until it resolves; rejection surfaces inline. */
  onsave: (next: string) => Promise<void> | void;
  /** Accessible label for the inline edit (e.g. "Edit name"). */
  label?: string;
  /** Disabled — render value as plain text, no edit affordance. */
  disabled?: boolean;
  /** Input max-length to prevent runaway pastes. Default 200. */
  maxLength?: number;
  /** Validator — return string error message to block save. */
  validate?: (next: string) => string | null;
}

let {
  value,
  placeholder = '—',
  onsave,
  label = 'Edit',
  disabled = false,
  maxLength = 200,
  validate,
}: Props = $props();

let editing = $state(false);
// `draft` is initialised to '' (typed) and overwritten from `value`
// every time the user enters edit mode (see enterEdit()). The previous
// shape — `$state(value)` — only captured the initial value at mount
// and stayed stale if the parent updated the prop while editing was
// closed.
let draft = $state<string>('');
let saving = $state(false);
let error = $state<string | null>(null);
let inputRef: HTMLInputElement | undefined = $state();

function enterEdit() {
  if (disabled) return;
  draft = value;
  error = null;
  editing = true;
  // Focus + select on next tick so the input is mounted.
  queueMicrotask(() => {
    inputRef?.focus();
    inputRef?.select();
  });
}

function cancel() {
  editing = false;
  error = null;
  draft = value;
}

async function commit() {
  if (saving) return;
  const next = draft.trim();
  if (next === value) {
    editing = false;
    return;
  }
  if (validate) {
    const err = validate(next);
    if (err) {
      error = err;
      return;
    }
  }
  saving = true;
  error = null;
  try {
    await onsave(next);
    editing = false;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Save failed';
  } finally {
    saving = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
}
</script>

<div class="relative" aria-live="polite">
  {#if editing}
    <div class="flex items-center gap-1">
      <input
        bind:this={inputRef}
        bind:value={draft}
        onkeydown={onKeydown}
        onblur={commit}
        disabled={saving}
        maxlength={maxLength}
        aria-invalid={!!error}
        aria-label={label}
        class="input input-xs flex-1 min-w-0 {error ? 'input-error' : ''}"
      />
      {#if saving}
        <LoaderCircle size={12} class="animate-spin text-primary shrink-0" />
      {:else}
        <button
          type="button"
          onmousedown={(e) => e.preventDefault()}
          onclick={commit}
          class="btn btn-ghost btn-xs text-success shrink-0"
          aria-label="Save"
        ><Check size={12} /></button>
        <button
          type="button"
          onmousedown={(e) => e.preventDefault()}
          onclick={cancel}
          class="btn btn-ghost btn-xs shrink-0"
          aria-label="Cancel edit"
        ><X size={12} /></button>
      {/if}
    </div>
    {#if error}
      <p class="text-xs text-error mt-0.5">{error}</p>
    {/if}
  {:else}
    <button
      type="button"
      onclick={enterEdit}
      ondblclick={enterEdit}
      {disabled}
      class="text-left w-full hover:underline decoration-dotted underline-offset-4 decoration-base-content/30 disabled:hover:no-underline disabled:cursor-default"
      aria-label="{label}: {value || placeholder}"
    >
      {#if value}{value}{:else}<span class="text-base-content/40">{placeholder}</span>{/if}
    </button>
  {/if}
</div>
