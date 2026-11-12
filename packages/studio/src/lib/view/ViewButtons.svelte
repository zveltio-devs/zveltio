<script lang="ts">
/**
 * A view's buttons: run an action, open a view, save a form. A button whose
 * `when` does not hold for the record, or whose action the caller may not run,
 * is not drawn; the engine still decides every call.
 */
import { type Button, matches, type Tone, type ViewScope } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import type { ViewHost } from './engine.js';

interface Props {
  buttons: Button[] | undefined;
  host: ViewHost;
  scope: ViewScope;
  /** The form's save, for `{ save: true }`; without it a save button is not drawn. */
  onSave?: () => void;
  size?: 'xs' | 'sm';
}
const { buttons, host, scope, onSave, size = 'sm' }: Props = $props();

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
    return !b.when || (scope.record ? matches(b.when, scope.record, scope) : true);
  }),
);

function label(b: Button): string {
  if (b.label) return host.t(b.label);
  if ('save' in b) return m['common.save']();
  return 'action' in b ? b.action : b.navigate;
}

let busy = $state(false);
async function press(b: Button) {
  if ('save' in b) return onSave?.();
  busy = true;
  try {
    await host.press(b, scope);
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
        disabled={busy}
        onclick={() => press(b)}
      >
        {label(b)}
      </button>
    {/each}
  </div>
{/if}
