<script lang="ts">
  /**
   * DemoBanner — renders a sticky banner at the top of every admin page
   * when the engine reports `demo_mode: true` on /api/health.
   *
   * The banner exists for two reasons:
   *   1. Set expectations: visitors should know this instance resets
   *      on a schedule, so they don't store anything important.
   *   2. Distinguish demo from production: an operator hitting a wrong
   *      URL needs a loud visual cue before they break something.
   *
   * State is fetched once on mount and cached on `window` to avoid
   * re-fetching across route changes.
   */
  import { onMount } from 'svelte';
  import { Sparkles, X } from '@lucide/svelte';
  import { api } from '$lib/api.js';

  interface DemoState {
    enabled: boolean;
    reset_cron?: string | null;
    credentials?: { email: string; password: string };
  }

  let demo = $state<DemoState | null>(null);
  let dismissed = $state(false);

  onMount(async () => {
    // Re-use a window-cached value across route changes; tab-scoped only.
    const cached = (window as any).__zveltioDemoCache as DemoState | undefined;
    if (cached) { demo = cached; return; }

    try {
      const res = await api.fetch(`/api/health`);
      const data = await res.json();
      const next: DemoState = {
        enabled: !!data?.demo_mode,
        reset_cron: data?.demo_reset_cron ?? null,
        credentials: data?.demo_credentials,
      };
      demo = next;
      (window as any).__zveltioDemoCache = next;
    } catch {
      /* engine unreachable — no banner */
    }

    // Dismiss state lives in sessionStorage so the banner reappears in a
    // fresh tab; we don't want a permanent "hide demo banner" decision.
    if (sessionStorage.getItem('zveltio-demo-dismissed') === '1') dismissed = true;
  });

  function dismiss() {
    dismissed = true;
    try { sessionStorage.setItem('zveltio-demo-dismissed', '1'); } catch { /* ignore */ }
  }
</script>

{#if demo?.enabled && !dismissed}
  <div role="status" aria-label="Demo mode banner" class="bg-warning text-warning-content px-4 py-2 flex items-center gap-3 text-sm shadow-md">
    <Sparkles size={16} class="shrink-0" />
    <div class="grow min-w-0">
      <strong class="font-semibold">Demo instance</strong>
      <span class="opacity-90">— data resets {demo.reset_cron ? `(${demo.reset_cron})` : 'periodically'}. Don't store anything important.</span>
      {#if demo.credentials}
        <span class="opacity-90 ml-1">
          Login: <code class="font-mono">{demo.credentials.email}</code> /
          <code class="font-mono">{demo.credentials.password}</code>
        </span>
      {/if}
    </div>
    <button class="btn btn-ghost btn-xs" onclick={dismiss} aria-label="Dismiss banner">
      <X size={14} />
    </button>
  </div>
{/if}
