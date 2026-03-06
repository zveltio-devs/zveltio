<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import {
 GitBranch, Plus, RefreshCw, Trash2, Eye, Merge, AlertCircle, CheckCircle, Clock, X,
 } from '@lucide/svelte';

 interface SchemaBranch {
 id: string;
 name: string;
 description: string | null;
 base_schema: string;
 branch_schema: string;
 status: 'open' | 'merged' | 'closed';
 changes: any[];
 created_by: string | null;
 merged_by: string | null;
 merged_at: string | null;
 created_at: string;
 updated_at: string;
 }

 interface Diff {
 collections_added: string[];
 collections_removed: string[];
 fields_modified: string[];
 }

 let branches = $state<SchemaBranch[]>([]);
 let loading = $state(true);
 let error = $state<string | null>(null);

 let showCreateModal = $state(false);
 let newBranchName = $state('');
 let newBranchDescription = $state('');
 let creating = $state(false);

 let showDiffModal = $state(false);
 let selectedBranch = $state<SchemaBranch | null>(null);
 let branchDiff = $state<Diff | null>(null);
 let loadingDiff = $state(false);

 let showMergeModal = $state(false);
 let merging = $state(false);
 let mergeResult = $state<{ applied: string[]; errors: string[] } | null>(null);

 let deleteTarget = $state<SchemaBranch | null>(null);

 onMount(loadBranches);

 async function loadBranches() {
 loading = true;
 error = null;
 try {
 const data = await api.get<{ branches: SchemaBranch[] }>('/api/schema/branches');
 branches = data.branches || [];
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to load branches';
 } finally {
 loading = false;
 }
 }

 function openCreateModal() {
 newBranchName = '';
 newBranchDescription = '';
 showCreateModal = true;
 }

 async function createBranch() {
 if (!newBranchName.trim()) return;
 creating = true;
 error = null;
 try {
 await api.post('/api/schema/branches', {
 name: newBranchName.trim(),
 description: newBranchDescription.trim() || undefined,
 });
 showCreateModal = false;
 await loadBranches();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to create branch';
 } finally {
 creating = false;
 }
 }

 async function viewDiff(branch: SchemaBranch) {
 selectedBranch = branch;
 showDiffModal = true;
 loadingDiff = true;
 branchDiff = null;
 try {
 const data = await api.get<{ diff: Diff }>(`/api/schema/branches/${branch.id}/diff`);
 branchDiff = data.diff;
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to load diff';
 } finally {
 loadingDiff = false;
 }
 }

 function openMergeModal(branch: SchemaBranch) {
 selectedBranch = branch;
 mergeResult = null;
 showMergeModal = true;
 }

 async function mergeBranch() {
 if (!selectedBranch) return;
 merging = true;
 try {
 const result = await api.post<{ success: boolean; applied: string[]; errors: string[] }>(
 `/api/schema/branches/${selectedBranch.id}/merge`
 );
 mergeResult = { applied: result.applied, errors: result.errors };
 if (result.success) await loadBranches();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to merge branch';
 } finally {
 merging = false;
 }
 }

 async function closeBranch() {
 if (!deleteTarget) return;
 try {
 await api.delete(`/api/schema/branches/${deleteTarget.id}`);
 deleteTarget = null;
 await loadBranches();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to close branch';
 }
 }

 function getStatusBadge(status: string) {
 switch (status) {
 case 'open': return 'badge-info';
 case 'merged': return 'badge-success';
 case 'closed': return 'badge-ghost';
 default: return 'badge-ghost';
 }
 }

 function formatDate(date: string | null): string {
 if (!date) return '—';
 return new Date(date).toLocaleString();
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold flex items-center gap-2"><GitBranch size={24} /> Schema Branches</h1>
 <p class="text-base-content/60 text-sm mt-1">Create isolated schema branches to safely test changes before applying to production</p>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm" onclick={loadBranches}><RefreshCw size={14} /></button>
 <button class="btn btn-primary btn-sm gap-1" onclick={openCreateModal}><Plus size={14} /> Create Branch</button>
 </div>
 </div>

 <div class="alert alert-info">
 <AlertCircle size={16} />
 <span class="text-sm">Branches create a copy of your schema in an isolated PostgreSQL schema. Test changes safely, then merge when ready.</span>
 </div>

 {#if error}
 <div class="alert alert-error"><AlertCircle size={16} /><span>{error}</span></div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if branches.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <GitBranch size={48} class="mx-auto opacity-30" />
 <h3 class="mt-4 font-medium">No Schema Branches</h3>
 <p class="text-sm opacity-60 mt-2">Create your first branch to test schema changes safely</p>
 <button class="btn btn-primary btn-sm mt-4 gap-1" onclick={openCreateModal}><Plus size={14} /> Create Branch</button>
 </div>
 {:else}
 <div class="card bg-base-100 shadow-sm overflow-hidden">
 <table class="table">
 <thead>
 <tr>
 <th>Branch Name</th>
 <th>Status</th>
 <th>Changes</th>
 <th>Created</th>
 <th class="text-right">Actions</th>
 </tr>
 </thead>
 <tbody>
 {#each branches as branch (branch.id)}
 <tr class="hover">
 <td>
 <div class="font-medium">{branch.name}</div>
 {#if branch.description}<div class="text-sm opacity-60">{branch.description}</div>{/if}
 </td>
 <td><span class="badge badge-sm {getStatusBadge(branch.status)}">{branch.status}</span></td>
 <td class="text-sm opacity-60">{branch.changes?.length || 0} changes</td>
 <td class="text-sm opacity-60">{formatDate(branch.created_at)}</td>
 <td>
 <div class="flex items-center justify-end gap-1">
 <button class="btn btn-ghost btn-xs gap-1" onclick={() => viewDiff(branch)}>
 <Eye size={12} /> Diff
 </button>
 {#if branch.status === 'open'}
 <button class="btn btn-success btn-xs gap-1" onclick={() => openMergeModal(branch)}>
 <Merge size={12} /> Merge
 </button>
 <button class="btn btn-ghost btn-xs text-error" onclick={() => (deleteTarget = branch)}>
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

<!-- Create Modal -->
{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">Create Schema Branch</h3>
 <div class="space-y-3">
 <div class="form-control">
 <label class="label"><span class="label-text">Branch Name *</span></label>
 <input type="text" bind:value={newBranchName} placeholder="e.g., add-user-settings" class="input" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Description</span></label>
 <textarea bind:value={newBranchDescription} rows="3" placeholder="Describe the purpose..." class="textarea"></textarea>
 </div>
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary gap-1" onclick={createBranch} disabled={!newBranchName.trim() || creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create Branch
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}

<!-- Diff Modal -->
{#if showDiffModal && selectedBranch}
 <dialog class="modal modal-open">
 <div class="modal-box max-w-2xl">
 <h3 class="font-bold text-lg mb-4">Branch Diff: {selectedBranch.name}</h3>
 {#if loadingDiff}
 <div class="flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>
 {:else if branchDiff}
 <div class="space-y-4">
 {#if branchDiff.collections_added.length > 0}
 <div>
 <h4 class="text-sm font-medium text-success mb-2">Collections Added ({branchDiff.collections_added.length})</h4>
 <ul class="list-disc list-inside text-sm space-y-1">
 {#each branchDiff.collections_added as col}<li class="font-mono">{col}</li>{/each}
 </ul>
 </div>
 {/if}
 {#if branchDiff.collections_removed.length > 0}
 <div>
 <h4 class="text-sm font-medium text-error mb-2">Collections Removed ({branchDiff.collections_removed.length})</h4>
 <ul class="list-disc list-inside text-sm space-y-1">
 {#each branchDiff.collections_removed as col}<li class="font-mono">{col}</li>{/each}
 </ul>
 </div>
 {/if}
 {#if branchDiff.fields_modified.length > 0}
 <div>
 <h4 class="text-sm font-medium text-warning mb-2">Fields Modified ({branchDiff.fields_modified.length})</h4>
 <ul class="list-disc list-inside text-sm space-y-1">
 {#each branchDiff.fields_modified as f}<li class="font-mono">{f}</li>{/each}
 </ul>
 </div>
 {/if}
 {#if branchDiff.collections_added.length === 0 && branchDiff.collections_removed.length === 0 && branchDiff.fields_modified.length === 0}
 <p class="text-sm opacity-60 text-center py-4">No changes detected in this branch.</p>
 {/if}
 </div>
 {/if}
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showDiffModal = false)}>Close</button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showDiffModal = false)}></button>
 </dialog>
{/if}

<!-- Merge Modal -->
{#if showMergeModal && selectedBranch}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">Merge Branch: {selectedBranch.name}</h3>
 {#if !mergeResult}
 <div class="alert alert-warning mb-4">
 <AlertCircle size={16} />
 <span class="text-sm">This will apply all changes to the production schema. This action cannot be undone.</span>
 </div>
 <p class="text-sm mb-4">{selectedBranch.changes?.length || 0} changes will be applied.</p>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showMergeModal = false)}>Cancel</button>
 <button class="btn btn-success gap-1" onclick={mergeBranch} disabled={merging}>
 {#if merging}<span class="loading loading-spinner loading-sm"></span>{:else}<Merge size={14} />{/if}
 Merge to Production
 </button>
 </div>
 {:else}
 <div class="space-y-3">
 {#if mergeResult.applied.length > 0}
 <div>
 <h4 class="text-sm font-medium text-success mb-2 flex items-center gap-1"><CheckCircle size={14} /> Applied ({mergeResult.applied.length})</h4>
 <ul class="list-disc list-inside text-sm">{#each mergeResult.applied as c}<li>{c}</li>{/each}</ul>
 </div>
 {/if}
 {#if mergeResult.errors.length > 0}
 <div>
 <h4 class="text-sm font-medium text-error mb-2 flex items-center gap-1"><AlertCircle size={14} /> Errors ({mergeResult.errors.length})</h4>
 <ul class="list-disc list-inside text-sm text-error">{#each mergeResult.errors as e}<li>{e}</li>{/each}</ul>
 </div>
 {/if}
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => { showMergeModal = false; mergeResult = null; }}>Close</button>
 </div>
 {/if}
 </div>
 <button class="modal-backdrop" onclick={() => (showMergeModal = false)}></button>
 </dialog>
{/if}

<!-- Delete/Close Confirmation -->
{#if deleteTarget}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-2">Close Branch</h3>
 <p class="text-sm opacity-70">Are you sure you want to close "{deleteTarget.name}"? This will delete the branch schema and all its data.</p>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (deleteTarget = null)}>Cancel</button>
 <button class="btn btn-error gap-1" onclick={closeBranch}><Trash2 size={14} /> Close Branch</button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (deleteTarget = null)}></button>
 </dialog>
{/if}
