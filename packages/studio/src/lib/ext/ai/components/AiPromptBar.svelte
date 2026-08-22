<script lang="ts">
/**
 * Global AI prompt bar — topbar.center slot (Model 2.5).
 *
 * Compact entry point into `/admin/ai`. Shown only when at least one provider
 * is configured; otherwise the top bar stays hidden (no empty chrome).
 */
import { base } from '$app/paths';
import { goto } from '$app/navigation';
import { Bot, Sparkles } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';

let ready = $state(false);
let configured = $state(false);
let draft = $state('');

async function loadProviders(): Promise<void> {
  try {
    const r = await api.get<{ providers?: Array<{ is_active?: boolean; has_api_key?: boolean }> }>(
      '/ext/ai/providers',
    );
    configured = (r.providers ?? []).some((p) => p.is_active !== false && p.has_api_key);
  } catch {
    configured = false;
  } finally {
    ready = true;
  }
}

$effect(() => {
  void loadProviders();
});

function openAi(prefill?: string): void {
  const q = prefill?.trim();
  goto(q ? `${base}/ai?q=${encodeURIComponent(q)}` : `${base}/ai`);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  openAi(draft);
}
</script>

{#if !ready}
  <span class="loading loading-spinner loading-xs opacity-40"></span>
{:else if configured}
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
{:else}
  <a href="{base}/ai" class="btn btn-ghost btn-sm gap-1 mx-auto">
    <Bot size={14} />
    {m['ai.topbar.setup']?.() ?? 'Set up AI providers'}
  </a>
{/if}
