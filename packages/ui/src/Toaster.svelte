<script lang="ts">
/** Draws `toast`'s messages (`@zveltio/ui`). Mount once per app. */
import { toast } from './toast.svelte.js';

let { dismissLabel }: { dismissLabel: string } = $props();

const kinds: Record<string, string> = {
  info: 'alert-info',
  success: 'alert-success',
  warning: 'alert-warning',
  error: 'alert-error',
};
</script>

<div class="toast toast-end z-50" role="status" aria-live="polite">
  {#each toast.items as t (t.id)}
    <div class="alert {kinds[t.kind]}" role={t.kind === 'error' ? 'alert' : undefined}>
      <span>{t.text}</span>
      <button class="btn btn-ghost btn-xs" onclick={() => toast.dismiss(t.id)} aria-label={dismissLabel}>✕</button>
    </div>
  {/each}
</div>
