<script lang="ts">
/**
 * Global AI prompt bar — topbar.center slot (Model 2.5).
 *
 * Compact entry point into the AI chat. Providers are an administrator's
 * collection, so the bar does not probe them: a chat with no active provider
 * answers with that error.
 */
import { resolve } from '$app/paths';
import { goto } from '$app/navigation';
import { Bot, Sparkles } from '@lucide/svelte';
import { m } from '#lib/i18n.svelte.js';

let draft = $state('');

function openAi(prefill?: string): void {
  const q = prefill?.trim();
  goto(q ? resolve(`ai/chat?q=${encodeURIComponent(q)}`) : resolve('ai/chat'));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  openAi(draft);
}
</script>

<form
  class="flex items-center gap-2 w-full max-w-xl mx-auto"
  onsubmit={(e) => {
    e.preventDefault();
    openAi(draft);
  }}
>
  <Sparkles size={16} class="text-primary shrink-0 hidden sm:block" />
  <input
    type="search"
    class="input input-sm input-bordered w-full bg-base-100/80"
    placeholder={m['ai.topbar.placeholder']?.() ?? 'Ask AI anything…'}
    bind:value={draft}
    onkeydown={onKeydown}
    aria-label={m['ai.topbar.placeholder']?.() ?? 'Ask AI anything'}
  />
  <button type="submit" class="btn btn-primary btn-sm gap-1 shrink-0">
    <Bot size={14} />
    <span class="hidden sm:inline">{m['ai.topbar.open']?.() ?? 'Open AI'}</span>
  </button>
</form>
