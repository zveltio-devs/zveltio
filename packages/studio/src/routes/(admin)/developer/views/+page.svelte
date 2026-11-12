<script lang="ts">
/**
 * View preview (ADR 0042 decision 8): paste a `view/2` document, see it checked
 * against the specification and drawn as you type — by the same renderer an
 * extension page uses, on the signed-in user's own data and permissions.
 */
import { validateView } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import ViewPage from '#lib/view/ViewPage.svelte';

const EXAMPLE = '{\n  "spec": "zveltio.view/2",\n  "type": "list",\n  "collection": "…"\n}';

let text = $state('');
let ext = $state('');

const checked = $derived.by(() => {
  if (!text.trim()) return null;
  try {
    return validateView(JSON.parse(text));
  } catch (e) {
    return { ok: false as const, issues: [{ path: '', message: (e as Error).message }] };
  }
});
</script>

<div class="p-6 space-y-4">
  <h1 class="text-2xl font-bold tracking-tight">{m['nav.viewPreview']()}</h1>
  <p class="text-sm text-base-content/65">{m['view.preview.help']()}</p>

  <div class="grid gap-6 lg:grid-cols-2">
    <div class="space-y-3">
      <label class="form-control">
        <span class="label-text">{m['view.preview.extension']()}</span>
        <input class="input input-bordered input-sm font-mono" bind:value={ext} />
      </label>
      <textarea
        class="textarea textarea-bordered w-full font-mono text-xs h-[60vh]"
        placeholder={EXAMPLE}
        spellcheck="false"
        aria-label={m['nav.viewPreview']()}
        bind:value={text}
      ></textarea>
      {#if checked && !checked.ok}
        <ul class="text-xs text-error font-mono space-y-1" data-testid="view-issues">
          {#each checked.issues as issue, i (i)}
            <li>{issue.path || '/'} {issue.message}</li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="min-w-0">
      {#if checked?.ok}
        {#key text}
          <ViewPage view={checked.view} ext={ext.trim()} />
        {/key}
      {/if}
    </div>
  </div>
</div>
