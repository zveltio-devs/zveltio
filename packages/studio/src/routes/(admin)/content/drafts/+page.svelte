<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { FileEdit, Send, LoaderCircle } from '@lucide/svelte';

  let drafts = $state<any[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      const r = await api.get<{ data: any[] }>('/ext/content/drafts');
      drafts = r.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function publish(id: string) {
    try {
      await api.post(`/ext/content/drafts/${id}/publish`, {});
      await load();
      toast.success('Draft published.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function discard(id: string) {
    if (!confirm('Discard draft?')) return;
    try {
      await api.delete(`/ext/content/drafts/${id}`);
      drafts = drafts.filter(d => d.id !== id);
      toast.success('Discarded.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  onMount(load);
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><FileEdit size={20} /> Drafts</h1>
    <p class="text-sm text-base-content/50">Pending drafts across all collections. Publish promotes the draft to the live record.</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Collection</th><th>Record</th><th>Author</th><th>Updated</th><th>Actions</th></tr></thead>
        <tbody>
          {#if drafts.length === 0}
            <tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No pending drafts.</td></tr>
          {:else}
            {#each drafts as d (d.id)}
              <tr class="hover">
                <td><span class="badge badge-ghost badge-sm">{d.collection}</span></td>
                <td class="font-mono text-xs">{d.record_id}</td>
                <td class="text-sm">{d.author_name ?? d.author_id}</td>
                <td class="text-xs text-base-content/40">{d.updated_at?.slice(0, 16).replace('T', ' ')}</td>
                <td>
                  <div class="flex items-center gap-1">
                    <button class="btn btn-success btn-xs gap-1" onclick={() => publish(d.id)}>
                      <Send size={11} /> Publish
                    </button>
                    <button class="btn btn-ghost btn-xs" onclick={() => discard(d.id)}>Discard</button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
