<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ShieldCheck, Plus, X, Sparkles, LoaderCircle } from '@lucide/svelte';

  let rules = $state<any[]>([]);
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
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
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
      try { cfg = JSON.parse(form.config); } catch { throw new Error('Invalid JSON in config'); }
      await api.post('/ext/developer/validation/rules', { ...form, config: cfg });
      showForm = false;
      form = { collection: '', field_name: '', field_type: 'text', rule_type: 'required', description: '', config: '{}', severity: 'error' };
      aiPrompt = '';
      await loadRules();
      toast.success('Rule created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
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
    } catch (e: any) { toast.error(e?.message ?? 'AI generation failed'); }
    finally { aiGenerating = false; }
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete rule?')) return;
    try { await api.delete(`/ext/developer/validation/rules/${id}`); await loadRules(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => { selectedCollection; loadRules(); });
  onMount(() => { loadCollections(); loadRules(); });

  function severityBadge(s: string) { return s === 'error' ? 'badge-error' : 'badge-warning'; }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><ShieldCheck size={20} /> Data Validation Rules</h1>
      <p class="text-sm text-base-content/50">Field-level validation with AI assistance</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New rule</button>
  </div>

  <div class="flex gap-3">
    <select class="select select-sm" bind:value={selectedCollection}>
      <option value="">All collections</option>
      {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
    </select>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Collection</th><th>Field</th><th>Rule type</th><th>Description</th><th>Severity</th><th></th></tr></thead>
        <tbody>
          {#if rules.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">No validation rules.</td></tr>
          {:else}{#each rules as r (r.id)}
            <tr class="hover"><td><span class="badge badge-ghost badge-sm">{r.collection}</span></td><td class="font-mono text-xs">{r.field_name ?? '—'}</td><td class="text-sm">{r.rule_type}</td><td class="text-sm max-w-xs truncate">{r.description ?? '—'}</td><td><span class="badge {severityBadge(r.severity)} badge-sm">{r.severity}</span></td><td><button class="btn btn-ghost btn-xs" onclick={() => deleteRule(r.id)}>Delete</button></td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New validation rule</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Collection *</span></label>
          <select class="select select-sm" bind:value={form.collection}>
            <option value="">—</option>
            {#each collections as c (c.name)}<option value={c.name}>{c.name}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Field *</span></label><input class="input input-sm font-mono" bind:value={form.field_name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Field type</span></label>
          <select class="select select-sm" bind:value={form.field_type}>
            <option value="text">text</option><option value="integer">integer</option><option value="number">number</option><option value="email">email</option><option value="date">date</option><option value="uuid">uuid</option><option value="boolean">boolean</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Rule type</span></label>
          <select class="select select-sm" bind:value={form.rule_type}>
            <option value="required">required</option><option value="min">min</option><option value="max">max</option><option value="pattern">pattern (regex)</option><option value="enum">enum</option><option value="custom">custom</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Severity</span></label>
          <select class="select select-sm" bind:value={form.severity}><option value="error">error (block)</option><option value="warning">warning (allow)</option></select>
        </div>
      </div>

      <div class="bg-base-200 rounded-lg p-3 mt-3">
        <div class="flex items-center gap-2 mb-2"><Sparkles size={14} class="text-primary" /><span class="font-medium text-xs">AI-assisted</span></div>
        <div class="flex gap-2">
          <input class="input input-xs flex-1" placeholder="e.g. 'Romanian CNP - 13 digits'" bind:value={aiPrompt} />
          <button class="btn btn-primary btn-xs" disabled={aiGenerating || !aiPrompt.trim() || !form.field_name} onclick={aiGenerate}>
            {#if aiGenerating}<LoaderCircle size={11} class="animate-spin" />{/if} Generate
          </button>
        </div>
        <p class="text-xs text-base-content/50 mt-1">Requires the AI extension to be active.</p>
      </div>

      <div class="mt-3 space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Description</span></label><input class="input input-sm" bind:value={form.description} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Config (JSON)</span></label><textarea class="textarea textarea-sm font-mono text-xs" rows="5" bind:value={form.config}></textarea></div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.collection || !form.field_name} onclick={createRule}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create rule
        </button>
      </div>
    </div>
  </div>
{/if}
