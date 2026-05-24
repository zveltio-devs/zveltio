<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
        import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, X, Trash2, LoaderCircle, FileText, Send, Download, Eye } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  type Template = { id: string; name: string; description: string | null; category: string | null; variables: string[] };
  type Doc = {
    id: string; template_id: string | null; filename: string; status: string;
    is_signed: boolean; created_by: string | null; created_at: string;
    share_token: string | null;
  };

  let templates = $state<Template[]>([]);
  let docs = $state<Doc[]>([]);
  let tab = $state<'documents' | 'templates'>('documents');
  let loading = $state(false);
  let showGenModal = $state(false);
  let saving = $state(false);
  let selectedTemplate = $state<Template | null>(null);
  let variables = $state<Record<string, string>>({});
  let signModal = $state<Doc | null>(null);
  let signForm = $state({ signer_email: '', signer_name: '', message: '' });

  onMount(async () => {
    await Promise.all([loadDocs(), loadTemplates()]);
  });

  async function loadDocs() {
    loading = true;
    try {
      const r = await api.get<{ documents: Doc[] }>('/ext/content/documents/generated');
      docs = r.documents ?? [];
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }
  async function loadTemplates() {
    try {
      const r = await api.get<{ templates: Template[] }>('/ext/content/documents/templates');
      templates = r.templates ?? [];
    } catch { /* ignore */ }
  }

  function openGenModal(t: Template) {
    selectedTemplate = t;
    variables = Object.fromEntries((t.variables ?? []).map(v => [v, '']));
    showGenModal = true;
  }

  async function generate() {
    if (!selectedTemplate) return;
    saving = true;
    try {
      const r = await api.post<{ document: Doc }>(`/ext/content/documents/generate/${selectedTemplate.id}`, { variables });
      docs = [r.document, ...docs];
      showGenModal = false;
      tab = 'documents';
      toast.success(m['content.documents.toast.generated']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  async function deleteDoc(id: string) {
        askConfirm(m['content.documents.confirmDelete'](), () => deleteDocConfirmed(id));
  }
  async function deleteDocConfirmed(id: string) {
    try {
      await api.delete(`/ext/content/documents/generated/${id}`);
      docs = docs.filter(d => d.id !== id);
      toast.success(m['ext.deleted']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


  async function sendSignRequest() {
    if (!signModal || !signForm.signer_email) return;
    saving = true;
    try {
      await api.post(`/ext/content/documents/generated/${signModal.id}/sign-request`, signForm);
      signModal = null;
      signForm = { signer_email: '', signer_name: '', message: '' };
      toast.success(m['ext.sent']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  const statusColor: Record<string, string> = {
    active: 'badge-success', expired: 'badge-warning', revoked: 'badge-error',
  };
</script>

<ExtensionPageShell title={m['content.documents.title']()} subtitle={m['content.documents.subtitle']()}>
  {#snippet children()}
<div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'documents' ? 'tab-active' : ''}" onclick={() => (tab = 'documents')}>
      <FileText size={13} class="mr-1.5" /> {m['content.documents.tab.generated']()}
    </button>
    <button class="tab {tab === 'templates' ? 'tab-active' : ''}" onclick={() => (tab = 'templates')}>
      <Plus size={13} class="mr-1.5" /> {m['content.documents.tab.templates']()}
    </button>
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'documents'}
    {#if docs.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center py-16 gap-3">
          <FileText size={36} class="text-base-content/20" />
          <p class="text-sm text-base-content/50">{m['content.documents.empty']()}</p>
          <button class="btn btn-primary btn-sm" onclick={() => (tab = 'templates')}>{m['content.documents.btn.viewTemplates']()}</button>
        </div>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>{m['content.documents.col.filename']()}</th><th>{m['common.col.status']()}</th><th>{m['content.documents.col.signed']()}</th><th>{m['common.col.created']()}</th><th>{m['common.actions']()}</th></tr></thead>
          <tbody>
            {#each docs as d (d.id)}
              <tr class="hover">
                <td class="font-medium text-sm">{d.filename}</td>
                <td><span class="badge badge-sm {statusColor[d.status] ?? 'badge-ghost'}">{d.status}</span></td>
                <td>{d.is_signed ? '✓' : '—'}</td>
                <td class="text-xs text-base-content/40">{new Date(d.created_at).toLocaleDateString()}</td>
                <td>
                  <div class="flex items-center gap-1">
                    {#if !d.is_signed}
                      <button class="btn btn-xs btn-ghost gap-1" title={m['content.documents.btn.requestSignature']()} onclick={() => { signModal = d; }}>
                        <Send size={11} />
                      </button>
                    {/if}
                    {#if d.share_token}
                      <button class="btn btn-xs btn-ghost" title={m['content.documents.btn.viewLink']()}
                        onclick={() => { navigator.clipboard.writeText(`${(window as any).__ZVELTIO_ENGINE_URL__ || ''}/ext/content/documents/share/${d.share_token}`); toast.success(m['ext.linkCopied']()); }}>
                        <Eye size={11} />
                      </button>
                    {/if}
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteDoc(d.id)}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    {#if templates.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">{m['content.documents.empty.templates']()}</div></div>
    {:else}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each templates as t (t.id)}
          <div class="card bg-base-200 hover:bg-base-300 transition-colors">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between">
                <div>
                  <p class="font-medium text-sm">{t.name}</p>
                  {#if t.category}<span class="badge badge-xs badge-ghost mt-1">{t.category}</span>{/if}
                </div>
                <FileText size={18} class="text-primary/40 shrink-0" />
              </div>
              {#if t.description}<p class="text-xs text-base-content/50">{t.description}</p>{/if}
              {#if t.variables?.length}
                <p class="text-xs text-base-content/40">{m['content.documents.variablesCount']({ n: String(t.variables.length) })}</p>
              {/if}
              <button class="btn btn-primary btn-xs gap-1 mt-2" onclick={() => openGenModal(t)}>
                <Plus size={11} /> {m['content.documents.btn.generate']()}
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
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

<!-- Generate Modal -->
{#if showGenModal && selectedTemplate}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['content.documents.generateLabel']()} {selectedTemplate.name}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showGenModal = false)}><X size={14} /></button>
      </div>
      {#if selectedTemplate.variables?.length}
        <div class="space-y-2 mb-4">
          {#each selectedTemplate.variables as v}
            <div class="form-control">
              <label class="label py-0"><span class="label-text text-xs">{v}</span></label>
              <input class="input input-sm" bind:value={variables[v]} />
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-sm text-base-content/50 mb-4">{m['content.documents.empty.noVariables']()}</p>
      {/if}
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showGenModal = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm gap-1" onclick={generate} disabled={saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}{m['content.documents.btn.generate']()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Sign Request Modal -->
{#if signModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['content.documents.ui.request_signature']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (signModal = null)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['content.documents.ui.signer_email']()}</span></label>
          <input class="input input-sm" type="email" bind:value={signForm.signer_email} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['content.documents.ui.signer_name']()}</span></label>
          <input class="input input-sm" bind:value={signForm.signer_name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['content.documents.ui.message_optional']()}</span></label>
          <textarea class="textarea textarea-sm" rows={2} bind:value={signForm.message}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (signModal = null)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm gap-1" onclick={sendSignRequest} disabled={!signForm.signer_email || saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}<Send size={13} /> {m['content.documents.btn.send']()}
        </button>
      </div>
    </div>
  </div>
{/if}
