<script lang="ts">
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
    try { const r = await api.get<{ data: any[] }>('/api/document-templates'); templates = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
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
      if (editing) await api.patch(`/api/document-templates/${editing.id}`, form);
      else await api.post('/api/document-templates', form);
      showForm = false;
      await load();
      toast.success(editing ? 'Template updated.' : 'Template created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  onMount(load);
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><FileType size={20} /> Document Templates</h1>
      <p class="text-sm text-base-content/50">Reusable templates with variable substitution</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={openCreate}><Plus size={14} /> New template</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Name</th><th>Format</th><th>Description</th><th></th></tr></thead>
        <tbody>
          {#if templates.length === 0}
            <tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No templates yet.</td></tr>
          {:else}
            {#each templates as t (t.id)}
              <tr class="hover">
                <td class="font-medium text-sm">{t.name}</td>
                <td><span class="badge badge-ghost badge-sm">{t.format}</span></td>
                <td class="text-sm max-w-xs truncate text-base-content/60">{t.description ?? '—'}</td>
                <td><button class="btn btn-ghost btn-xs" onclick={() => openEdit(t)}>Edit</button></td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{editing ? 'Edit' : 'New'} template</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Name *</span></label>
            <input class="input input-sm" bind:value={form.name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Format</span></label>
            <select class="select select-sm" bind:value={form.format}>
              <option value="html">HTML (PDF)</option>
              <option value="docx">DOCX</option>
              <option value="markdown">Markdown</option>
            </select>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Description</span></label>
          <input class="input input-sm" bind:value={form.description} />
        </div>
        <div class="form-control">
          <label class="label py-0">
            <span class="label-text text-xs">Body — use <code class="text-xs">{`{{var_name}}`}</code> for substitution</span>
          </label>
          <textarea class="textarea textarea-sm font-mono text-xs" rows="12" bind:value={form.body}></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name} onclick={save}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Save
        </button>
      </div>
    </div>
  </div>
{/if}
