<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import { DatabaseBackup, Plus, Download, Trash2, RefreshCw, LoaderCircle, Clock, CheckCircle, XCircle } from '@lucide/svelte';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';

 interface Backup {
 id: string;
 filename: string;
 size_bytes: number | null;
 size_human: string | null;
 status: 'in_progress' | 'completed' | 'failed';
 error: string | null;
 notes: string | null;
 created_by: string | null;
 created_at: string;
 completed_at: string | null;
 }

 let backups = $state<Backup[]>([]);
 let loading = $state(true);
 let error = $state('');
 let creating = $state(false);
 let notes = $state('');
 let showModal = $state(false);
 let pollingIds = $state<Set<string>>(new Set());
 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

 onMount(loadBackups);

 async function loadBackups() {
 loading = true;
 error = '';
 try {
 const data = await api.get<{ backups: Backup[] }>('/api/backup');
 backups = data.backups || [];
 // Resume polling for any in_progress backups
 for (const b of backups) {
 if (b.status === 'in_progress' && !pollingIds.has(b.id)) {
 pollBackup(b.id);
 }
 }
 } catch (e: any) {
 error = e.message;
 } finally {
 loading = false;
 }
 }

 async function createBackup() {
 creating = true;
 error = '';
 try {
 const data = await api.post<{ backup_id: string; filename: string }>('/api/backup', { notes: notes.trim() || undefined });
 showModal = false;
 notes = '';
 await loadBackups();
 pollBackup(data.backup_id);
 } catch (e: any) {
 error = e.message;
 } finally {
 creating = false;
 }
 }

 function pollBackup(id: string) {
 if (pollingIds.has(id)) return;
 pollingIds = new Set([...pollingIds, id]);

 const interval = setInterval(async () => {
 try {
 const status = await api.get<{ status: string; size_human: string | null; error: string | null }>(`/api/backup/${id}/status`);
 if (status.status !== 'in_progress') {
 clearInterval(interval);
 pollingIds = new Set([...pollingIds].filter(x => x !== id));
 await loadBackups();
 }
 } catch {
 clearInterval(interval);
 pollingIds = new Set([...pollingIds].filter(x => x !== id));
 }
 }, 3000);
 }

 async function deleteBackup(id: string, filename: string) {
 confirmState = {
 open: true,
 title: 'Delete Backup',
 message: `Delete backup "${filename}"?`,
 confirmLabel: 'Delete',
 onconfirm: async () => {
 confirmState.open = false;
 try {
 await api.delete(`/api/backup/${id}`);
 backups = backups.filter(b => b.id !== id);
 } catch (e: any) {
 error = e.message;
 }
 },
 };
 }

 function downloadBackup(id: string) {
 window.open(`/api/backup/${id}/download`, '_blank');
 }

 function fmtDate(s: string) {
 return new Date(s).toLocaleString('en-US', {
 year: 'numeric', month: 'short', day: '2-digit',
 hour: '2-digit', minute: '2-digit',
 });
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Backup</h1>
 <p class="text-base-content/60 text-sm mt-1">Create and manage database backups</p>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm" onclick={loadBackups} disabled={loading}>
 <RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
 </button>
 <button class="btn btn-primary btn-sm" onclick={() => (showModal = true)}>
 <Plus size={16} /> New Backup
 </button>
 </div>
 </div>

 {#if error}
 <div class="alert alert-error text-sm">{error}</div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-16">
 <LoaderCircle size={32} class="animate-spin text-primary" />
 </div>
 {:else if backups.length === 0}
 <div class="text-center py-16 text-base-content/40">
 <DatabaseBackup size={48} class="mx-auto mb-3" />
 <p class="text-sm">No backups yet.</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showModal = true)}>
 <Plus size={14} /> Create First Backup
 </button>
 </div>
 {:else}
 <div class="card bg-base-200">
 <div class="card-body p-0">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>Filename</th>
 <th>Status</th>
 <th>Size</th>
 <th>Created</th>
 <th>Notes</th>
 <th class="w-24">Actions</th>
 </tr>
 </thead>
 <tbody>
 {#each backups as backup}
 <tr class="hover">
 <td class="font-mono text-xs truncate max-w-xs">{backup.filename}</td>
 <td>
 {#if backup.status === 'completed'}
 <span class="badge badge-success badge-sm gap-1"><CheckCircle size={11} /> Done</span>
 {:else if backup.status === 'in_progress'}
 <span class="badge badge-warning badge-sm gap-1">
 <LoaderCircle size={11} class="animate-spin" /> Running
 </span>
 {:else}
 <span class="badge badge-error badge-sm gap-1" title={backup.error || ''}>
 <XCircle size={11} /> Failed
 </span>
 {/if}
 </td>
 <td class="text-xs">{backup.size_human || '—'}</td>
 <td class="text-xs">{fmtDate(backup.created_at)}</td>
 <td class="text-xs text-base-content/60 max-w-xs truncate">{backup.notes || '—'}</td>
 <td>
 <div class="flex gap-1">
 {#if backup.status === 'completed'}
 <button class="btn btn-ghost btn-xs" onclick={() => downloadBackup(backup.id)} title="Download">
 <Download size={13} />
 </button>
 {/if}
 <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteBackup(backup.id, backup.filename)}>
 <Trash2 size={13} />
 </button>
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

<!-- Create Backup Modal -->
{#if showModal}
 <div class="modal modal-open">
 <div class="modal-box max-w-sm">
 <h3 class="font-bold text-lg mb-4">New Backup</h3>
 <div class="form-control">
 <label class="label" for="backup-notes"><span class="label-text">Notes (optional)</span></label>
 <input id="backup-notes" class="input" bind:value={notes} placeholder="e.g. Before migration" />
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createBackup} disabled={creating}>
 {#if creating}<LoaderCircle size={16} class="animate-spin" />{/if}
 Start Backup
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label="Close"
 onclick={() => (showModal = false)}
 onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }}
 ></div>
 </div>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
