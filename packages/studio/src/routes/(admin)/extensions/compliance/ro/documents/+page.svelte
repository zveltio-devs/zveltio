<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, CheckCircle, Trash2, FileText, LoaderCircle } from '@lucide/svelte';

  const DOC_TYPES = ['contract', 'pv', 'nir', 'dispozitie_plata', 'proces_verbal', 'notificare', 'other'];
  const DOC_LABELS: Record<string, string> = {
    contract: 'Contract', pv: 'Proces Verbal', nir: 'NIR',
    dispozitie_plata: 'Dispozitie Plata', proces_verbal: 'Proces Verbal',
    notificare: 'Notificare', other: 'Altele',
  };

  let documents = $state<any[]>([]);
  let loading = $state(true);
  let filter = $state('all');
  let showCreateModal = $state(false);
  let creating = $state(false);

  let form = $state({
    type: 'contract',
    number: '',
    date: new Date().toISOString().split('T')[0],
    title: '',
    parties: [{ name: '', cui: '', role: 'client' }],
    content: '',
  });

  async function loadDocuments() {
    loading = true;
    try {
      const qs = filter !== 'all' ? `?type=${filter}` : '';
      const r = await api.get<{ documents: any[] }>(`/api/ro-documents${qs}`);
      documents = r.documents ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  $effect(() => { filter; loadDocuments(); });
  onMount(loadDocuments);

  async function createDocument() {
    if (!form.title || !form.number) return;
    creating = true;
    try {
      await api.post('/api/ro-documents', form);
      showCreateModal = false;
      await loadDocuments();
      toast.success('Document creat.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function signDocument(id: string) {
    if (!confirm('Marchează documentul ca semnat?')) return;
    try { await api.patch(`/api/ro-documents/${id}/sign`, {}); await loadDocuments(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function deleteDocument(id: string) {
    if (!confirm('Șterge documentul?')) return;
    try { await api.delete(`/api/ro-documents/${id}`); await loadDocuments(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  function statusBadge(status: string): string {
    if (status === 'signed') return 'badge-success';
    if (status === 'archived') return 'badge-ghost';
    return 'badge-warning';
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><FileText size={20} /> Documente RO</h1>
      <p class="text-sm text-base-content/50">Gestiune documente de conformitate</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showCreateModal = true)}><Plus size={14} /> Document nou</button>
  </div>

  <div class="flex flex-wrap gap-2">
    <button class="btn btn-sm {filter === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = 'all')}>Toate</button>
    {#each DOC_TYPES as t}
      <button class="btn btn-sm {filter === t ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = t)}>{DOC_LABELS[t]}</button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if documents.length === 0}
    <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">Nu există documente.</div></div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Tip</th><th>Număr</th><th>Data</th><th>Titlu</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#each documents as doc (doc.id)}
            <tr class="hover">
              <td><span class="badge badge-outline badge-sm">{DOC_LABELS[doc.type] || doc.type}</span></td>
              <td class="font-mono text-sm">{doc.number}</td>
              <td class="text-sm">{doc.date}</td>
              <td class="text-sm">{doc.title}</td>
              <td><span class="badge badge-sm {statusBadge(doc.status)}">{doc.status}</span></td>
              <td>
                <div class="flex gap-1">
                  {#if doc.status === 'draft'}
                    <button class="btn btn-ghost btn-xs gap-1" onclick={() => signDocument(doc.id)}>
                      <CheckCircle size={12} /> Semnat
                    </button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteDocument(doc.id)}>
                      <Trash2 size={12} />
                    </button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-2xl">
      <h3 class="font-bold text-lg mb-4">Document nou</h3>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="form-control">
          <label class="label" for="doc-type"><span class="label-text">Tip document</span></label>
          <select id="doc-type" bind:value={form.type} class="select select-sm">
            {#each DOC_TYPES as t}<option value={t}>{DOC_LABELS[t]}</option>{/each}
          </select>
        </div>
        <div class="form-control">
          <label class="label" for="doc-number"><span class="label-text">Număr</span></label>
          <input id="doc-number" type="text" bind:value={form.number} placeholder="CT-2026-001" class="input input-sm font-mono" />
        </div>
        <div class="form-control">
          <label class="label" for="doc-date"><span class="label-text">Data</span></label>
          <input id="doc-date" type="date" bind:value={form.date} class="input input-sm" />
        </div>
        <div class="form-control col-span-2">
          <label class="label" for="doc-title"><span class="label-text">Titlu</span></label>
          <input id="doc-title" type="text" bind:value={form.title} placeholder="Contract prestari servicii IT" class="input input-sm" />
        </div>
      </div>

      <div class="mb-4">
        <div class="flex justify-between mb-2">
          <label class="label-text font-medium">Parti implicate</label>
          <button class="btn btn-ghost btn-xs" onclick={() => (form.parties = [...form.parties, { name: '', cui: '', role: 'beneficiar' }])}>+ Parte</button>
        </div>
        {#each form.parties as party}
          <div class="grid grid-cols-3 gap-2 mb-2">
            <input type="text" bind:value={party.name} placeholder="Denumire" class="input input-xs" />
            <input type="text" bind:value={party.cui} placeholder="CUI" class="input input-xs font-mono" />
            <input type="text" bind:value={party.role} placeholder="Rol" class="input input-xs" />
          </div>
        {/each}
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Anulare</button>
        <button class="btn btn-primary" onclick={createDocument} disabled={creating || !form.title || !form.number}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if} Creare
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}
