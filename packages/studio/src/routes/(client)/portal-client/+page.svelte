<script lang="ts">
/**
 * Zone root.
 *
 * Sign-in sends the visitor to `/portal-client/`, and there was no route at
 * that path — every successful portal login landed on a 404. The zone has no
 * dashboard of its own: its content is the pages an administrator configured,
 * so the root forwards to the page marked as homepage, or to the first one.
 */
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { api } from '#lib/api.js';
import { loadSite } from '#lib/ext/content/pages/client/load.js';

type NavPage = { slug: string; title: string; is_homepage?: boolean; is_active?: boolean };

let empty = $state(false);

onMount(async () => {
  try {
    const pages: NavPage[] =
      (await loadSite((path: string, init?: RequestInit) => api.fetch(path, init), 'client'))
        ?.nav ?? [];
    const target = pages.find((p) => p.is_homepage) ?? pages[0];
    if (target) {
      goto(resolve(`portal-client/${target.slug}`), { replace: true });
      return;
    }
  } catch {
    // Zone not configured / unreachable — fall through to the empty state.
  }
  empty = true;
});
</script>

{#if empty}
  <div class="text-center py-16 text-base-content/65 text-sm">
    This portal has no pages yet.
  </div>
{:else}
  <div class="flex items-center justify-center py-20">
    <span class="loading loading-spinner loading-md text-primary"></span>
  </div>
{/if}
