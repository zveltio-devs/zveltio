<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ShieldCheck, Plus, X, Sparkles, LoaderCircle } from '@lucide/svelte';

let rules = $state<any[]>([]);
  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let collections = $state<any[]>([]);
  let selectedCollection = $state('');
  let loading = $state(false);

  let showForm = $state(false);
  let saving = $state(false);
  let aiGenerating = $state(false);
  let form = $state({
    collection: '',
    field_name: '',
    field_type: 'text',
    rule_type: 'required',
    description: '',
    config: '{}',
    severity: 'error' as 'error' | 'warning',
  });
  let aiPrompt = $state('');

  async function loadRules() {
    loading = true;
    try {
      const params = new URLSearchParams();
      if (selectedCollection) params.set('collection', selectedCollection);
      const r = await api.get<{ data: any[] }>(`/ext/developer/validation/rules?${params}`);
      rules = r.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? m['ext.loadFailed']()); }
    finally { loading = false; }
  }
  async function loadCollections() {
    try { const r = await api.get<{ collections?: any[]; data?: any[] }>('/api/collections'); collections = r.collections ?? r.data ?? []; }
    catch { collections = []; }
  }

  async function createRule() {
    saving = true;
    try {
      let cfg: any = {};
      try { cfg = JSON.parse(form.config); } catch { throw new Error(m['developer.validation.error.invalidJson']()); }
      await api.post('/ext/developer/validation/rules', { ...form, config: cfg });
      showForm = false;
      form = { collection: '', field_name: '', field_type: 'text', rule_type: 'required', description: '', config: '{}', severity: 'error' };
      aiPrompt = '';
      await loadRules();
      toast.success(m['developer.validation.toast.created']());
    } catch (e: any) { toast.error(e?.message ?? m['ext.saveFailed']()); }
    finally { saving = false; }
  }

  async function aiGenerate() {
    if (!aiPrompt.trim() || !form.field_name) return;
    aiGenerating = true;
    try {
      const r = await api.post<any>('/ext/developer/validation/ai-generate', { field_name: form.field_name, field_type: form.field_type, description: aiPrompt });
      const ai = r.data ?? r;
      form.rule_type = ai.rule_type ?? form.rule_type;
      form.description = ai.description ?? aiPrompt;
      form.config = JSON.stringify(ai.config ?? {}, null, 2);
    } catch (e: any) { toast.error(e?.message ?? m['developer.validation.error.aiFailed']()); }
    finally { aiGenerating = false; }
  }

  async function deleteRule(id: string) {
        askConfirm(m['developer.validation.confirmDelete'](), () => deleteRuleConfirmed(id));
  }
  async function deleteRuleConfirmed(id: string) {
    try { await api.delete(`/ext/developer/validation/rules/${id}`); await loadRules(); }
    catch (e: any) { toast.error(e?.message ?? m['ext.saveFailed']()); }
  }


  $effect(() => { selectedCollection; loadRules(); });
  onMount(() => { loadCollections(); loadRules(); });

  function severityBadge(s: string) { return s === 'error' ? 'badge-error' : 'badge-warning'; }
</script>

<ExtensionPageShell title={m['developer.validation.title']()} subtitle={m['developer.validation.subtitle']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> {m['developer.validation.newRule']()}</button>
  {/snippet}
  <div class="space-y-4">
  <div class="flex gap-3">
    <select class="select select-sm" bind:value={selectedCollection}>
      <option value="">{m['developer.validation.allCollections']()}</option>
      {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
    </select>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.collection']()}</th><th>{m['common.col.field']()}</th><th>{m['developer.validation.col.ruleType']()}</th><th>{m['common.col.description']()}</th><th>{m['developer.validation.col.severity']()}</th><th></th></tr></thead>
        <tbody>
          {#if rules.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">{m['developer.validation.empty']()}</td></tr>
          {:else}{#each rules as r (r.id)}
            <tr class="hover"><td><span class="badge badge-ghost badge-sm">{r.collection}</span></td><td class="font-mono text-xs">{r.field_name ?? '—'}</td><td class="text-sm">{r.rule_type}</td><td class="text-sm max-w-xs truncate">{r.description ?? '—'}</td><td><span class="badge {severityBadge(r.severity)} badge-sm">{r.severity}</span></td><td><button class="btn btn-ghost btn-xs" onclick={() => deleteRule(r.id)}>{m['common.delete']()}</button></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
  </div>

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
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">{m['developer.validation.modal.title']()}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.collection']()} *</span></label>
          <select class="select select-sm" bind:value={form.collection}>
            <option value="">—</option>
            {#each collections as c (c.name)}<option value={c.name}>{c.name}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.field']()} *</span></label><input class="input input-sm font-mono" bind:value={form.field_name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.fieldType']()}</span></label>
          <select class="select select-sm" bind:value={form.field_type}>
            <option value="text">{m['developer.validation.type.text']()}</option><option value="integer">{m['developer.validation.type.integer']()}</option><option value="number">{m['developer.validation.type.number']()}</option><option value="email">{m['developer.validation.type.email']()}</option><option value="date">{m['developer.validation.type.date']()}</option><option value="uuid">{m['developer.validation.type.uuid']()}</option><option value="boolean">{m['developer.validation.type.boolean']()}</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.ruleType']()}</span></label>
          <select class="select select-sm" bind:value={form.rule_type}>
            <option value="required">{m['developer.validation.rule.required']()}</option><option value="min">{m['developer.validation.rule.min']()}</option><option value="max">{m['developer.validation.rule.max']()}</option><option value="pattern">{m['developer.validation.rule.pattern']()}</option><option value="enum">{m['developer.validation.rule.enum']()}</option><option value="custom">{m['developer.validation.rule.custom']()}</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.severity']()}</span></label>
          <select class="select select-sm" bind:value={form.severity}><option value="error">{m['developer.validation.severity.error']()}</option><option value="warning">{m['developer.validation.severity.warning']()}</option></select>
        </div>
      </div>

      <div class="bg-base-200 rounded-lg p-3 mt-3">
        <div class="flex items-center gap-2 mb-2"><Sparkles size={14} class="text-primary" /><span class="font-medium text-xs">{m['developer.validation.aiAssisted']()}</span></div>
        <div class="flex gap-2">
          <input class="input input-xs flex-1" placeholder={m['developer.validation.aiPlaceholder']()} bind:value={aiPrompt} />
          <button class="btn btn-primary btn-xs" disabled={aiGenerating || !aiPrompt.trim() || !form.field_name} onclick={aiGenerate}>
            {#if aiGenerating}<LoaderCircle size={11} class="animate-spin" />{/if} {m['common.generate']()}
          </button>
        </div>
        <p class="text-xs text-base-content/50 mt-1">{m['developer.validation.aiRequires']()}</p>
      </div>

      <div class="mt-3 space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.form.description']()}</span></label><input class="input input-sm" bind:value={form.description} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['developer.validation.configJson']()}</span></label><textarea class="textarea textarea-sm font-mono text-xs" rows="5" bind:value={form.config}></textarea></div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.collection || !form.field_name} onclick={createRule}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['developer.validation.newRule']()}
        </button>
      </div>
    </div>
  </div>
{/if}
