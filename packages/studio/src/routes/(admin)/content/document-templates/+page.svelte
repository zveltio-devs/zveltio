<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
      import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { FileType, Plus, X, LoaderCircle } from '@lucide/svelte';

  let templates = $state<any[]>([]);
  let loading = $state(true);
  let showForm = $state(false);
  let saving = $state(false);
  let editing = $state<any | null>(null);
  let form = $state({
    name: '',
    description: '',
    format: 'html',
    body: '<h1>{{title}}</h1>\n<p>Hello {{client_name}}</p>',
  });

  async function load() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/content/document-templates'); templates = r.data ?? []; }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  function openCreate() {
    editing = null;
    form = { name: '', description: '', format: 'html', body: '<h1>{{title}}</h1>\n<p>Hello {{client_name}}</p>' };
    showForm = true;
  }

  function openEdit(t: any) {
    editing = t;
    form = { name: t.name, description: t.description ?? '', format: t.format, body: t.body };
    showForm = true;
  }

  async function save() {
    saving = true;
    try {
      if (editing) await api.patch(`/ext/content/document-templates/${editing.id}`, form);
      else await api.post('/ext/content/document-templates', form);
      showForm = false;
      await load();
      toast.success(editing ? 'Template updated.' : 'Template created.');
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  onMount(load);
</script>

<ExtensionPageShell title={m['content.document-templates.title']()} subtitle={m['content.document-templates.subtitle']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm gap-1" onclick={openCreate}><Plus size={14} /> {m['content.document-templates.btn.new']()}</button>
  {/snippet}

  {#snippet children()}
  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.name']()}</th><th>{m['content.document-templates.col.format']()}</th><th>{m['common.col.description']()}</th><th></th></tr></thead>
        <tbody>
          {#if templates.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['content.document-templates.ui.no_templates_yet']()}</td></tr>
          {:else}
            {#each templates as t (t.id)}
              <tr class="hover">
                <td class="font-medium text-sm">{t.name}</td>
                <td><span class="badge badge-ghost badge-sm">{t.format}</span></td>
                <td class="text-sm max-w-xs truncate text-base-content/60">{t.description ?? '—'}</td>
                <td><button class="btn btn-ghost btn-xs" onclick={() => openEdit(t)}>{m['common.edit']()}</button></td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
  {/snippet}
</ExtensionPageShell>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{editing ? m['content.document-templates.modal.edit']() : m['content.document-templates.modal.new']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.ui.name']()}</span></label>
            <input class="input input-sm" bind:value={form.name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.ui.format']()}</span></label>
            <select class="select select-sm" bind:value={form.format}>
              <option value="html">{m['content.document-templates.ui.html_pdf']()}</option>
              <option value="docx">{m['content.document-templates.format.docx']()}</option>
              <option value="markdown">{m['content.document-templates.ui.markdown']()}</option>
            </select>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.col.description']()}</span></label>
          <input class="input input-sm" bind:value={form.description} />
        </div>
        <div class="form-control">
          <label class="label py-0">
            <span class="label-text text-xs">{m['content.document-templates.bodyHint']()}</span>
          </label>
          <textarea class="textarea textarea-sm font-mono text-xs" rows="12" bind:value={form.body}></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name} onclick={save}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}{m['common.save']()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{editing ? m['content.document-templates.modal.edit']() : m['content.document-templates.modal.new']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.ui.name']()}</span></label>
            <input class="input input-sm" bind:value={form.name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.ui.format']()}</span></label>
            <select class="select select-sm" bind:value={form.format}>
              <option value="html">{m['content.document-templates.ui.html_pdf']()}</option>
              <option value="docx">{m['content.document-templates.format.docx']()}</option>
              <option value="markdown">{m['content.document-templates.ui.markdown']()}</option>
            </select>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.col.description']()}</span></label>
          <input class="input input-sm" bind:value={form.description} />
        </div>
        <div class="form-control">
          <label class="label py-0">
            <span class="label-text text-xs">{m['content.document-templates.bodyHint']()}</span>
          </label>
          <textarea class="textarea textarea-sm font-mono text-xs" rows="12" bind:value={form.body}></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name} onclick={save}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}{m['common.save']()}
        </button>
      </div>
    </div>
  </div>
{/if}
