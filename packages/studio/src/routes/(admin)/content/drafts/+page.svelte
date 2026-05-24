<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
        import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { FileEdit, Send, LoaderCircle } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let drafts = $state<any[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      const r = await api.get<{ data: any[] }>('/ext/content/drafts');
      drafts = r.data ?? [];
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  async function publish(id: string) {
    try {
      await api.post(`/ext/content/drafts/${id}/publish`, {});
      await load();
      toast.success(m['content.drafts.toast.published']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }

  async function discard(id: string) {
        askConfirm(m['content.drafts.confirmDiscard'](), () => discardConfirmed(id));
  }
  async function discardConfirmed(id: string) {
    try {
      await api.delete(`/ext/content/drafts/${id}`);
      drafts = drafts.filter(d => d.id !== id);
      toast.success(m['content.drafts.toast.discarded']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


  onMount(load);
</script>

<ExtensionPageShell title={m['content.drafts.title']()} subtitle={m['content.drafts.subtitle']()}>
{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.collection']()}</th><th>{m['content.drafts.col.record']()}</th><th>{m['content.drafts.col.author']()}</th><th>{m['content.drafts.col.updated']()}</th><th>{m['common.actions']()}</th></tr></thead>
        <tbody>
          {#if drafts.length === 0}
            <tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">{m['content.drafts.ui.no_pending_drafts']()}</td></tr>
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
                      <Send size={11} /> {m['content.drafts.btn.publish']()}
                    </button>
                    <button class="btn btn-ghost btn-xs" onclick={() => discard(d.id)}>{m['common.discard']()}</button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>
