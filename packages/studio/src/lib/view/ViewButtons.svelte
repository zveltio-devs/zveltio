<script lang="ts">
/**
 * A view's buttons: run an action, open a view, save a form. A button whose
 * `when` does not hold for the record, or whose action the caller may not run,
 * is not drawn; the engine still decides every call. While the record meets a
 * button's `busyWhen` the button is busy and the page reads its records again
 * (`host.hold`) until it no longer does. A button whose `input`, `params` or
 * `files` names a value the scope does not have yet (no row selected in the
 * pane) is disabled; a form's button resolves them on the saved record.
 */
import { type Button, isBound, matches, type Tone, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import type { ViewHost } from './engine.js';

interface Props {
  buttons: Button[] | undefined;
  host: ViewHost;
  scope: ViewScope;
  /** The form's save, for `{ save: true }`; without it a save button is not drawn. */
  onSave?: () => void | Promise<void>;
  /** Before an action runs, after its prompt and confirm (a form saves): the scope it runs on, or `null`. */
  beforeAction?: (scope: ViewScope) => Promise<ViewScope | null>;
  size?: 'xs' | 'sm';
}
const { buttons, host, scope, onSave, beforeAction, size = 'sm' }: Props = $props();

const TONE: Record<Tone, string> = {
  neutral: 'btn-neutral',
  info: 'btn-info',
  success: 'btn-success',
  warning: 'btn-warning',
  danger: 'btn-error',
  muted: 'btn-ghost',
};

const shown = $derived(
  (buttons ?? []).filter((b) => {
    if ('save' in b) return !!onSave;
    if ('action' in b && !host.canRun(b.action)) return false;
    // A `when` holds of a record: with none in scope (a toolbar) it cannot hold.
    return !b.when || (!!scope.record && matches(b.when, scope.record, scope));
  }),
);

function label(b: Button): string {
  if (b.label) return host.t(b.label);
  if ('save' in b) return m['common.save']();
  return 'action' in b ? b.action : b.navigate;
}

/** The record meets the button's `busyWhen`: the work it started is under way. */
const working = (b: Button) =>
  'busyWhen' in b && !!b.busyWhen && !!scope.record && matches(b.busyWhen, scope.record, scope);
/** A reference has no value yet; with `beforeAction` it is resolved after the save. */
const unbound = (b: Button) => !beforeAction && !isBound(b, scope);
const anyWorking = $derived(shown.some(working));
$effect(() => {
  if (anyWorking) return host.hold();
});

let busy = $state(false);
/** Held until the save, or the action with its prompt and confirm, settles: no double submit. */
async function press(b: Button) {
  if (busy) return;
  busy = true;
  try {
    if ('save' in b) await onSave?.();
    else await host.press(b, scope, 'action' in b ? beforeAction : undefined);
  } finally {
    busy = false;
  }
}
</script>

{#if shown.length}
  <div class="flex flex-wrap gap-2">
    {#each shown as b, i (i)}
      <button
        type="button"
        class={`btn btn-${size} ${'tone' in b && b.tone ? TONE[b.tone] : 'save' in b ? 'btn-primary' : 'btn-outline'}`}
        disabled={busy || working(b) || unbound(b)}
        aria-busy={working(b)}
        onclick={() => press(b)}
      >
        {#if working(b)}<span class="loading loading-spinner loading-xs"></span>{/if}
        {label(b)}
      </button>
    {/each}
  </div>
{/if}
