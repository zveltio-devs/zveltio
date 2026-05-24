<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
        import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ENGINE_URL } from '$lib/config.js';
  import { BookOpen, Plus, X, FileCode, Key, LoaderCircle } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let tab = $state<'changelog' | 'custom' | 'tokens'>('changelog');
  let changelogs = $state<any[]>([]);
  let customDocs = $state<any[]>([]);
  let tokens = $state<any[]>([]);
  let loading = $state(false);

  let showCustomForm = $state(false);
  let saving = $state(false);
  let customForm = $state({ slug: '', title: '', body: '# New documentation page\n\nWrite content in Markdown.', is_public: false });

  async function loadChangelog() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/developer/api-docs/changelogs'); changelogs = r.data ?? []; }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }
  async function loadCustom() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/developer/api-docs/custom'); customDocs = r.data ?? []; }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }
  async function loadTokens() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/ext/developer/api-docs/access-tokens'); tokens = r.data ?? []; }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  async function createCustom() {
    saving = true;
    try {
      await api.post('/ext/developer/api-docs/custom', customForm);
      showCustomForm = false;
      customForm = { slug: '', title: '', body: '# New documentation page\n\nWrite content in Markdown.', is_public: false };
      await loadCustom();
      toast.success(m['ext.created']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  async function generateToken() {
    try { await api.post('/ext/developer/api-docs/access-tokens', {}); await loadTokens(); toast.success(m['developer.apiDocs.toast.tokenGenerated']()); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }
  async function revokeToken(id: string) {
        askConfirm(m['developer.apiDocs.confirmRevoke'](), () => revokeTokenConfirmed(id));
  }
  async function revokeTokenConfirmed(id: string) {
    try { await api.delete(`/ext/developer/api-docs/access-tokens/${id}`); await loadTokens(); toast.success(m['developer.apiDocs.toast.revoked']()); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


  $effect(() => {
    if (tab === 'changelog') loadChangelog();
    else if (tab === 'custom') loadCustom();
    else loadTokens();
  });
  onMount(loadChangelog);
</script>

<ExtensionPageShell title={m['developer.api-docs.title']()} subtitle={m['developer.api-docs.subtitle']()}>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showCustomForm = true)}><Plus size={14} /> {m['developer.api-docs.btn.newPage']()}</button>
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={generateToken}><Plus size={14} /> {m['developer.api-docs.btn.generateToken']()}</button>
  {/snippet}

<div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'changelog' ? 'tab-active' : ''}" onclick={() => (tab = 'changelog')}>{m['developer.api-docs.tab.changelog']()}</button>
    <button class="tab {tab === 'custom' ? 'tab-active' : ''}" onclick={() => (tab = 'custom')}><FileCode size={13} class="mr-1.5" /> {m['developer.api-docs.tab.customPages']()}</button>
    <button class="tab {tab === 'tokens' ? 'tab-active' : ''}" onclick={() => (tab = 'tokens')}><Key size={13} class="mr-1.5" /> {m['developer.api-docs.tab.tokens']()}</button>
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'changelog'}
    <div class="space-y-3">
      <a class="link link-primary text-sm" href="{ENGINE_URL}/api/openapi.json" target="_blank">{m['developer.api-docs.link.openApi']()}</a>
      {#if changelogs.length === 0}
        <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">{m['developer.api-docs.empty.changelog']()}</div></div>
      {:else}
        {#each changelogs as c (c.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-1">
              <div class="flex items-baseline justify-between">
                <h3 class="font-semibold">v{c.version}</h3>
                <span class="text-xs text-base-content/60">{c.released_at?.slice(0, 10)}</span>
              </div>
              <div class="text-sm whitespace-pre-line">{c.notes}</div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {:else if tab === 'custom'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.slug']()}</th><th>{m['common.col.title']()}</th><th>{m['developer.api-docs.col.public']()}</th><th>{m['developer.api-docs.col.updated']()}</th></tr></thead>
        <tbody>
          {#if customDocs.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['developer.api-docs.ui.no_custom_doc_pages']()}</td></tr>
          {:else}{#each customDocs as d (d.id)}
            <tr class="hover"><td class="font-mono text-xs">{d.slug}</td><td class="text-sm">{d.title}</td><td>{d.is_public ? '✓' : '—'}</td><td class="text-xs">{d.updated_at?.slice(0, 10)}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['developer.api-docs.col.token']()}</th><th>{m['common.col.created']()}</th><th>{m['developer.api-docs.col.lastUsed']()}</th><th></th></tr></thead>
        <tbody>
          {#if tokens.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['developer.api-docs.ui.no_tokens_generate_one_for_read_only_doc_access']()}</td></tr>
          {:else}{#each tokens as t (t.id)}
            <tr class="hover"><td class="font-mono text-xs">{t.token_preview ?? `${t.token?.slice(0, 12)}…`}</td><td class="text-xs">{t.created_at?.slice(0, 16).replace('T', ' ')}</td><td class="text-xs">{t.last_used_at?.slice(0, 16).replace('T', ' ') ?? 'never'}</td><td><button class="btn btn-ghost btn-xs" onclick={() => revokeToken(t.id)}>{m['common.revoke']()}</button></td></tr>
          {/each}{/if}
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

{#if showCustomForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">{m['developer.api-docs.ui.new_doc_page']()}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showCustomForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['content.page-builder.ui.slug']()}</span></label><input class="input input-sm font-mono" bind:value={customForm.slug} placeholder={m['developer.api-docs.ui.getting_started']()} /></div>
          <div class="flex items-end pb-1"><label class="label cursor-pointer gap-2"><input type="checkbox" class="checkbox checkbox-sm" bind:checked={customForm.is_public} /><span class="label-text text-xs">{m['developer.api-docs.ui.public']()}</span></label></div>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.api-docs.ui.title']()}</span></label><input class="input input-sm" bind:value={customForm.title} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.api-docs.ui.body_markdown']()}</span></label><textarea class="textarea textarea-sm font-mono text-xs" rows="14" bind:value={customForm.body}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showCustomForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !customForm.slug || !customForm.title} onclick={createCustom}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['developer.api-docs.btn.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
