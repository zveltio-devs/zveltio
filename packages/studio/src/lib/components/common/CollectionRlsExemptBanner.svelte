<script lang="ts">
// Extensions an operator exempted from collection permissions in the database
// (ZVELTIO_COLLECTION_RLS_EXEMPT). Not dismissible: the exemption is meant to
// be temporary, and a banner that can be closed for good is how it becomes
// permanent without anyone deciding so. Admins only — the endpoint refuses
// everyone else, and then nothing renders.
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { ShieldAlert } from '@lucide/svelte';
import { api } from '$lib/api.js';

let exempt = $state<string[]>([]);

onMount(async () => {
  try {
    const res = await api.fetch('/api/health/collection-exemptions');
    if (!res.ok) return;
    const data = (await res.json()) as { configured?: string[]; applied?: string[] };
    exempt = data.applied?.length ? data.applied : (data.configured ?? []);
  } catch {
    /* non-fatal: no banner */
  }
});
</script>

{#if exempt.length > 0}
  <div class="alert alert-warning py-2 px-4 rounded-none flex items-center gap-2 text-sm" role="status">
    <ShieldAlert size={16} />
    <span>{m['shell.collection_rls_exempt']({ count: String(exempt.length), names: exempt.join(', ') })}</span>
  </div>
{/if}
