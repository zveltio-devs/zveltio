<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, CheckCircle, Trash2, FileText } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 const DOC_TYPES = ['contract', 'pv', 'nir', 'dispozitie_plata', 'proces_verbal', 'notificare', 'other'];
 const DOC_LABELS: Record<string, string> = {
 contract: 'Contract',
 pv: 'Proces Verbal',
 nir: 'NIR',
 dispozitie_plata: 'Dispozitie Plata',
 proces_verbal: 'Proces Verbal',
 notificare: 'Notificare',
 other: 'Altele',
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

 onMount(() => loadDocuments());

 async function loadDocuments() {
 loading = true;
 try {
 const qs = filter !== 'all' ? `?type=${filter}` : '';
 const res = await fetch(`${engineUrl}/api/ro-documents${qs}`, { credentials: 'include' });
 const data = await res.json();
 documents = data.documents || [];
 } finally {
 loading = false;
 }
 }

 $effect(() => { if (filter) loadDocuments(); });

 async function createDocument() {
 if (!form.title || !form.number) return;
 creating = true;
 try {
 const res = await fetch(`${engineUrl}/api/ro-documents`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(form),
 });
 if (!res.ok) throw new Error('Failed');
 showCreateModal = false;
 await loadDocuments();
 } finally {
 creating = false;
 }
 }

 async function signDocument(id: string) {
 if (!confirm('Mark this document as signed?')) return;
 await fetch(`${engineUrl}/api/ro-documents/${id}/sign`, {
 method: 'PATCH',
 credentials: 'include',
 });
 await loadDocuments();
 }

 async function deleteDocument(id: string) {
 if (!confirm('Delete this draft?')) return;
 await fetch(`${engineUrl}/api/ro-documents/${id}`, { method: 'DELETE', credentials: 'include' });
 await loadDocuments();
 }

 function statusBadge(status: string): string {
 if (status === 'signed') return 'badge-success';
 if (status === 'archived') return 'badge-ghost';
 return 'badge-warning';
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Documente RO</h1>
 <p class="text-base-content/60 text-sm mt-1">Gestiune documente de conformitate</p>
 </div>
 <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
 <Plus size={16} />
 Document nou
 </button>
 </div>

 <!-- Type filter tabs -->
 <div class="flex flex-wrap gap-2">
 <button class="btn btn-sm {filter === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = 'all')}>Toate</button>
 {#each DOC_TYPES as t}
 <button class="btn btn-sm {filter === t ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = t)}>
 {DOC_LABELS[t]}
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if documents.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <FileText size={48} class="mx-auto text-base-content/20 mb-3" />
 <p class="text-base-content/60">Nu există documente</p>
 </div>
 {:else}
 <div class="card bg-base-200">
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr><th>Tip</th><th>Număr</th><th>Data</th><th>Titlu</th><th>Status</th><th></th></tr>
 </thead>
 <tbody>
 {#each documents as doc}
 <tr>
 <td><span class="badge badge-outline badge-sm">{DOC_LABELS[doc.type] || doc.type}</span></td>
 <td class="font-mono">{doc.number}</td>
 <td>{doc.date}</td>
 <td>{doc.title}</td>
 <td><span class="badge badge-sm {statusBadge(doc.status)}">{doc.status}</span></td>
 <td>
 <div class="flex gap-1">
 {#if doc.status === 'draft'}
 <button class="btn btn-ghost btn-xs gap-1" onclick={() => signDocument(doc.id)}>
 <CheckCircle size={12} />
 Semnat
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
 </div>
 {/if}
</div>

{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box w-11/12 max-w-2xl">
 <h3 class="font-bold text-lg mb-4">Document nou</h3>
 <div class="grid grid-cols-2 gap-3 mb-4">
 <div class="form-control">
 <label class="label"><span class="label-text">Tip document</span></label>
 <select bind:value={form.type} class="select select-sm">
 {#each DOC_TYPES as t}<option value={t}>{DOC_LABELS[t]}</option>{/each}
 </select>
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Număr</span></label>
 <input type="text" bind:value={form.number} placeholder="CT-2026-001" class="input input-sm font-mono" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Data</span></label>
 <input type="date" bind:value={form.date} class="input input-sm" />
 </div>
 <div class="form-control col-span-2">
 <label class="label"><span class="label-text">Titlu</span></label>
 <input type="text" bind:value={form.title} placeholder="Contract prestari servicii IT" class="input input-sm" />
 </div>
 </div>

 <div class="mb-4">
 <div class="flex justify-between mb-2">
 <label class="label-text font-medium">Parti implicate</label>
 <button class="btn btn-ghost btn-xs" onclick={() => (form.parties = [...form.parties, { name: '', cui: '', role: 'beneficiar' }])}>+ Parte</button>
 </div>
 {#each form.parties as party, i}
 <div class="grid grid-cols-3 gap-2 mb-2">
 <input type="text" bind:value={party.name} placeholder="Denumire" class="input input-xs" />
 <input type="text" bind:value={party.cui} placeholder="CUI" class="input input-xs font-mono" />
 <input type="text" bind:value={party.role} placeholder="Rol" class="input input-xs" />
 </div>
 {/each}
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Anulare</button>
 <button class="btn btn-primary" onclick={createDocument} disabled={creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Creare
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}
