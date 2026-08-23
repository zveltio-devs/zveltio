<script lang="ts">
/**
 * Dashboard hero contribution — AI greeting strip (Model 2.5 `dashboard.hero`).
 *
 * Complements the core time-of-day greeting; does not replace it.
 */
import { base } from '$app/paths';
import { Sparkles } from '@lucide/svelte';

type Ctx = {
  user?: { name?: string | null } | null;
};

let { user }: Ctx = $props();

const firstName = $derived((user?.name ?? '').split(' ')[0] || '');
</script>

<a
  href="{base}/ai/chat"
  class="flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 hover:border-primary/50 transition-colors"
  data-testid="ai-dashboard-hero"
>
  <Sparkles class="w-5 h-5 text-primary shrink-0" />
  <div class="min-w-0 text-sm">
    <div class="font-medium text-base-content">
      {firstName ? `Ask AI anything, ${firstName}` : 'Ask AI anything'}
    </div>
    <div class="text-base-content/55 truncate">
      Summaries, drafts, and lookups — open the prompt bar or jump to AI.
    </div>
  </div>
</a>
