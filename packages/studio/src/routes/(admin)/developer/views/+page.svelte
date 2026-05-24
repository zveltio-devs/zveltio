<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { LayoutGrid, Plus, X, List, KanbanSquare, Calendar, Map, LoaderCircle } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let views = $state<any[]>([]);
  let collections = $state<any[]>([]);
  let loading = $state(true);

  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    name: '',
    collection: '',
    view_type: 'list',
    config: '{\n  "columns": [],\n  "filters": [],\n  "sort": []\n}',
  });

  async function load() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/api/views'); views = r.data ?? []; }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }
  async function loadCollections() {
    try { const r = await api.get<{ collections?: any[]; data?: any[] }>('/api/collections'); collections = r.collections ?? r.data ?? []; }
    catch {}
  }

  async function createView() {
    saving = true;
    try {
      let cfg: any = {};
      try { cfg = JSON.parse(form.config); } catch { throw new Error(m['developer.views.error.invalidJson']()); }
      await api.post('/api/views', { ...form, config: cfg });
      showForm = false;
      form = { name: '', collection: '', view_type: 'list', config: '{\n  "columns": [],\n  "filters": [],\n  "sort": []\n}' };
      await load();
      toast.success(m['developer.views.toast.created']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  async function deleteView(id: string) {
        askConfirm(m['developer.views.confirmDelete'](), () => deleteViewConfirmed(id));
  }
  async function deleteViewConfirmed(id: string) {
    try { await api.delete(`/api/views/${id}`); await load(); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


  onMount(() => { load(); loadCollections(); });

  const VIEW_ICONS: Record<string, any> = { list: List, board: KanbanSquare, calendar: Calendar, map: Map, card: LayoutGrid };
</script>

<ExtensionPageShell title={m['developer.views.title']()} subtitle={m['developer.views.subtitle']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> {m['developer.views.btn.newView']()}</button>
  {/snippet}

  {#snippet children()}
  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#if views.length === 0}
        <div class="col-span-full card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">{m['developer.views.empty']()}</div></div>
      {:else}
        {#each views as v (v.id)}
          {@const Icon = VIEW_ICONS[v.view_type] ?? List}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between">
                <div class="flex items-center gap-2">
                  <Icon size={16} class="text-base-content/60" />
                  <div class="font-medium text-sm">{v.name}</div>
                </div>
                <span class="badge badge-ghost badge-sm">{v.view_type}</span>
              </div>
              <div class="text-xs text-base-content/60 font-mono">{v.collection}</div>
              <div class="flex justify-end"><button class="btn btn-ghost btn-xs text-error" onclick={() => deleteView(v.id)}>{m['common.delete']()}</button></div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
  {/snippet}

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

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-lg">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">{m['developer.views.ui.new_view']()}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.ui.name']()}</span></label><input class="input input-sm" bind:value={form.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.ui.collection']()}</span></label>
          <select class="select select-sm" bind:value={form.collection}>
            <option value="">—</option>
            {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.views.ui.view_type']()}</span></label>
          <select class="select select-sm" bind:value={form.view_type}>
            <option value="list">{m['developer.views.ui.list']()}</option>
            <option value="board">{m['developer.views.ui.kanban_board']()}</option>
            <option value="card">{m['developer.views.ui.card_grid']()}</option>
            <option value="calendar">{m['developer.views.ui.calendar']()}</option>
            <option value="map">{m['developer.views.ui.map_requires_postgis']()}</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.ui.config_json']()}</span></label><textarea class="textarea textarea-sm font-mono text-xs" rows="7" bind:value={form.config}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name || !form.collection} onclick={createView}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
