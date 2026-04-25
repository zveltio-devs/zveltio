<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import {
    GitBranch, Plus, RefreshCw, Trash2, Eye, Merge, AlertCircle,
    CircleCheck, Clock, X, Globe, GlobeLock, ShieldCheck, ShieldX, MessageSquare,
  } from '@lucide/svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  interface SchemaBranch {
    id: string;
    name: string;
    description: string | null;
    base_schema: string;
    branch_schema: string;
    status: 'open' | 'merged' | 'closed';
    changes: any[];
    requires_approval: boolean;
    review_status: 'approved' | 'rejected' | 'changes_requested' | null;
    created_by: string | null;
    merged_by: string | null;
    merged_at: string | null;
    created_at: string;
    updated_at: string;
    preview_enabled?: boolean;
    preview_token?: string | null;
    preview_expires_at?: string | null;
  }

  interface Diff {
    collections_added: string[];
    collections_removed: string[];
    fields_modified: string[];
  }

  let branches      = $state<SchemaBranch[]>([]);
  let loading       = $state(true);
  let showCreateModal = $state(false);
  let newBranchName = $state('');
  let newBranchDesc = $state('');
  let creating      = $state(false);

  let showDiffModal  = $state(false);
  let selectedBranch = $state<SchemaBranch | null>(null);
  let branchDiff     = $state<Diff | null>(null);
  let loadingDiff    = $state(false);

  let showMergeModal = $state(false);
  let merging        = $state(false);
  let mergeResult    = $state<{ success: boolean; applied: string[]; errors: string[]; review_status?: string } | null>(null);

  let deleteTarget = $state<SchemaBranch | null>(null);
  let previewToken = $state<string | null>(null);
  let previewBranch = $state<SchemaBranch | null>(null);
  let enablingPreview = $state(false);

  // Review panel
  let showReviewModal = $state(false);
  let reviewBranch    = $state<SchemaBranch | null>(null);
  let reviewStatus    = $state<'approved' | 'rejected' | 'changes_requested'>('approved');
  let reviewNote      = $state('');
  let submittingReview = $state(false);
  let reviews         = $state<any[]>([]);
  let loadingReviews  = $state(false);

  onMount(loadBranches);

  async function loadBranches() {
    loading = true;
    try {
      const data = await api.get<{ branches: SchemaBranch[] }>('/api/schema/branches');
      branches = data.branches || [];
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load branches');
    } finally {
      loading = false;
    }
  }

  async function createBranch() {
    if (!newBranchName.trim()) return;
    creating = true;
    try {
      await api.post('/api/schema/branches', {
        name: newBranchName.trim(),
        description: newBranchDesc.trim() || undefined,
      });
      showCreateModal = false;
      newBranchName = '';
      newBranchDesc = '';
      await loadBranches();
      toast.success('Branch created');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create branch');
    } finally { creating = false; }
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
      toast.error(e instanceof Error ? e.message : 'Failed to load diff');
    } finally { loadingDiff = false; }
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
      const result = await api.post<{ success: boolean; applied: string[]; errors: string[]; review_status?: string }>(
        `/api/schema/branches/${selectedBranch.id}/merge`,
      );
      mergeResult = result;
      if (result.success) await loadBranches();
    } catch (e: any) {
      // Approval gate returns 403 with structured error
      const body = e?.body ?? e;
      mergeResult = {
        success: false,
        applied: [],
        errors: [body?.error ?? (e instanceof Error ? e.message : 'Merge failed')],
        review_status: body?.review_status,
      };
    } finally { merging = false; }
  }

  async function closeBranch() {
    if (!deleteTarget) return;
    try {
      await api.delete(`/api/schema/branches/${deleteTarget.id}`);
      deleteTarget = null;
      await loadBranches();
      toast.success('Branch closed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to close branch');
    }
  }

  async function enablePreview(branch: SchemaBranch) {
    enablingPreview = true;
    try {
      const res = await api.post<{ preview_token: string; expires_at: string | null }>(
        `/api/schema/branches/${branch.id}/preview`,
        { ttl_hours: 168 },
      );
      previewToken = res.preview_token;
      previewBranch = branch;
      await loadBranches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to enable preview');
    } finally { enablingPreview = false; }
  }

  async function disablePreview(branch: SchemaBranch) {
    try {
      await api.delete(`/api/schema/branches/${branch.id}/preview`);
      previewToken = null;
      previewBranch = null;
      await loadBranches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to disable preview');
    }
  }

  async function openReviewModal(branch: SchemaBranch) {
    reviewBranch = branch;
    reviewStatus = 'approved';
    reviewNote = '';
    showReviewModal = true;
    loadingReviews = true;
    try {
      const res = await api.get<{ reviews: any[] }>(`/api/schema/branches/${branch.id}/reviews`);
      reviews = res.reviews ?? [];
    } catch { reviews = []; }
    finally { loadingReviews = false; }
  }

  async function submitReview() {
    if (!reviewBranch) return;
    submittingReview = true;
    try {
      await api.post(`/api/schema/branches/${reviewBranch.id}/review`, {
        status: reviewStatus,
        note: reviewNote || undefined,
      });
      toast.success(`Review submitted: ${reviewStatus}`);
      showReviewModal = false;
      await loadBranches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit review');
    } finally { submittingReview = false; }
  }

  async function toggleRequiresApproval(branch: SchemaBranch) {
    try {
      await api.patch(`/api/schema/branches/${branch.id}`, {
        requires_approval: !branch.requires_approval,
      });
      await loadBranches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update branch');
    }
  }

  function reviewBadge(status: string | null) {
    if (!status) return 'badge-ghost';
    return { approved: 'badge-success', rejected: 'badge-error', changes_requested: 'badge-warning' }[status] ?? 'badge-ghost';
  }

  function statusBadge(status: string) {
    return { open: 'badge-info', merged: 'badge-success', closed: 'badge-ghost' }[status] ?? 'badge-ghost';
  }

  function fmt(d: string | null) {
    return d ? new Date(d).toLocaleString() : '—';
  }
</script>

<div class="space-y-6">
  <PageHeader title="Schema Branches" subtitle="Manage database schema versions">
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={loadBranches}><RefreshCw size={14} /></button>
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showCreateModal = true)}><Plus size={14} /> Create Branch</button>
    </div>
  </PageHeader>

  <div class="alert alert-info">
    <AlertCircle size={16} />
    <span class="text-sm">Branches create an isolated PostgreSQL schema copy. Test schema changes safely, then merge when ready.</span>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if branches.length === 0}
    <div class="card bg-base-200 text-center py-12">
      <GitBranch size={48} class="mx-auto opacity-30" />
      <h3 class="mt-4 font-medium">No Schema Branches</h3>
      <p class="text-sm opacity-60 mt-2">Create your first branch to test schema changes safely</p>
      <button class="btn btn-primary btn-sm mt-4 gap-1" onclick={() => (showCreateModal = true)}><Plus size={14} /> Create Branch</button>
    </div>
  {:else}
    <div class="card bg-base-100 shadow-sm overflow-x-auto">
      <table class="table">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Status</th>
            <th>Review</th>
            <th>Approval required</th>
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
                {#if branch.description}<div class="text-xs opacity-50">{branch.description}</div>{/if}
              </td>
              <td><span class="badge badge-sm {statusBadge(branch.status)}">{branch.status}</span></td>
              <td>
                {#if branch.review_status}
                  <span class="badge badge-sm {reviewBadge(branch.review_status)}">{branch.review_status.replace('_', ' ')}</span>
                {:else}
                  <span class="text-xs text-base-content/30">none</span>
                {/if}
              </td>
              <td>
                {#if branch.status === 'open'}
                  <input
                    type="checkbox"
                    class="toggle toggle-xs toggle-warning"
                    checked={branch.requires_approval}
                    onchange={() => toggleRequiresApproval(branch)}
                    title="Require approval before merge"
                  />
                {:else}
                  <span class="text-xs text-base-content/30">—</span>
                {/if}
              </td>
              <td class="text-sm opacity-60">{branch.changes?.length || 0}</td>
              <td class="text-sm opacity-60">{fmt(branch.created_at)}</td>
              <td>
                <div class="flex items-center justify-end gap-1">
                  <button class="btn btn-ghost btn-xs gap-1" onclick={() => viewDiff(branch)} title="View diff">
                    <Eye size={12} /> Diff
                  </button>

                  {#if branch.status === 'open'}
                    <!-- Preview -->
                    {#if branch.preview_enabled}
                      <button class="btn btn-info btn-xs gap-1" onclick={() => { previewToken = branch.preview_token ?? null; previewBranch = branch; }} title="Show preview token">
                        <Globe size={12} />
                      </button>
                      <button class="btn btn-ghost btn-xs text-warning" onclick={() => disablePreview(branch)} title="Disable preview">
                        <GlobeLock size={12} />
                      </button>
                    {:else}
                      <button class="btn btn-ghost btn-xs gap-1" onclick={() => enablePreview(branch)} disabled={enablingPreview} title="Enable preview">
                        <Globe size={12} />
                      </button>
                    {/if}

                    <!-- Review -->
                    <button class="btn btn-ghost btn-xs gap-1" onclick={() => openReviewModal(branch)} title="Submit review">
                      <MessageSquare size={12} /> Review
                    </button>

                    <!-- Merge -->
                    <button
                      class="btn btn-success btn-xs gap-1"
                      onclick={() => openMergeModal(branch)}
                      title={branch.requires_approval && branch.review_status !== 'approved' ? 'Approval required before merge' : 'Merge to production'}
                    >
                      <Merge size={12} /> Merge
                    </button>

                    <button class="btn btn-ghost btn-xs text-error" onclick={() => (deleteTarget = branch)} title="Close branch">
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
          <label class="label" for="branch-name"><span class="label-text">Branch Name *</span></label>
          <input id="branch-name" type="text" bind:value={newBranchName} placeholder="add-user-settings" class="input" />
        </div>
        <div class="form-control">
          <label class="label" for="branch-desc"><span class="label-text">Description</span></label>
          <textarea id="branch-desc" bind:value={newBranchDesc} rows="2" placeholder="What does this branch change?" class="textarea"></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createBranch} disabled={!newBranchName.trim() || creating}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          Create
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}

<!-- Diff Modal -->
{#if showDiffModal && selectedBranch}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <h3 class="font-bold text-lg mb-4">Diff: {selectedBranch.name}</h3>
      {#if loadingDiff}
        <div class="flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>
      {:else if branchDiff}
        <div class="space-y-4">
          {#if branchDiff.collections_added.length}
            <div>
              <p class="text-sm font-medium text-success mb-1">Added collections ({branchDiff.collections_added.length})</p>
              <ul class="list-disc list-inside text-sm font-mono space-y-0.5">
                {#each branchDiff.collections_added as c}<li>{c}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if branchDiff.collections_removed.length}
            <div>
              <p class="text-sm font-medium text-error mb-1">Removed collections ({branchDiff.collections_removed.length})</p>
              <ul class="list-disc list-inside text-sm font-mono space-y-0.5">
                {#each branchDiff.collections_removed as c}<li>{c}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if branchDiff.fields_modified.length}
            <div>
              <p class="text-sm font-medium text-warning mb-1">Modified fields ({branchDiff.fields_modified.length})</p>
              <ul class="list-disc list-inside text-sm font-mono space-y-0.5">
                {#each branchDiff.fields_modified as f}<li>{f}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if !branchDiff.collections_added.length && !branchDiff.collections_removed.length && !branchDiff.fields_modified.length}
            <p class="text-sm opacity-50 text-center py-4">No changes detected.</p>
          {/if}
        </div>
      {/if}
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showDiffModal = false)}>Close</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showDiffModal = false)}></button>
  </dialog>
{/if}

<!-- Review Modal -->
{#if showReviewModal && reviewBranch}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-4 flex items-center gap-2">
        <MessageSquare size={18} /> Review: {reviewBranch.name}
      </h3>

      <!-- Past reviews -->
      {#if loadingReviews}
        <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
      {:else if reviews.length > 0}
        <div class="mb-4 space-y-2">
          <p class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Review history</p>
          {#each reviews as r}
            <div class="flex items-start gap-2 bg-base-200 rounded p-2 text-sm">
              <span class="badge badge-xs {reviewBadge(r.status)} mt-0.5">{r.status?.replace('_', ' ')}</span>
              <div class="flex-1 min-w-0">
                {#if r.reviewer_note}<p class="text-xs text-base-content/70">{r.reviewer_note}</p>{/if}
                <p class="text-xs text-base-content/30">{fmt(r.reviewed_at ?? r.created_at)}</p>
              </div>
            </div>
          {/each}
        </div>
        <div class="divider my-2"></div>
      {/if}

      <!-- New review form -->
      <div class="space-y-3">
        <p class="text-sm font-medium">Submit new review</p>
        <div class="flex gap-2">
          <button
            class="btn btn-sm flex-1 gap-1 {reviewStatus === 'approved' ? 'btn-success' : 'btn-ghost'}"
            onclick={() => (reviewStatus = 'approved')}
          >
            <ShieldCheck size={14} /> Approve
          </button>
          <button
            class="btn btn-sm flex-1 gap-1 {reviewStatus === 'changes_requested' ? 'btn-warning' : 'btn-ghost'}"
            onclick={() => (reviewStatus = 'changes_requested')}
          >
            <MessageSquare size={14} /> Request Changes
          </button>
          <button
            class="btn btn-sm flex-1 gap-1 {reviewStatus === 'rejected' ? 'btn-error' : 'btn-ghost'}"
            onclick={() => (reviewStatus = 'rejected')}
          >
            <ShieldX size={14} /> Reject
          </button>
        </div>
        <div class="form-control">
          <label class="label" for="review-note"><span class="label-text text-xs">Note (optional)</span></label>
          <textarea id="review-note" bind:value={reviewNote} class="textarea textarea-sm" rows="2" placeholder="Add a comment..."></textarea>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showReviewModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={submitReview} disabled={submittingReview}>
          {#if submittingReview}<span class="loading loading-spinner loading-sm"></span>{/if}
          Submit Review
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showReviewModal = false)}></button>
  </dialog>
{/if}

<!-- Merge Modal -->
{#if showMergeModal && selectedBranch}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">Merge: {selectedBranch.name}</h3>
      {#if !mergeResult}
        {#if selectedBranch.requires_approval && selectedBranch.review_status !== 'approved'}
          <div class="alert alert-warning mb-4">
            <AlertCircle size={16} />
            <span class="text-sm">This branch requires an approved review before merging. Current status: <strong>{selectedBranch.review_status ?? 'none'}</strong></span>
          </div>
        {:else}
          <div class="alert alert-warning mb-4">
            <AlertCircle size={16} />
            <span class="text-sm">This will apply all {selectedBranch.changes?.length || 0} changes to the production schema. Cannot be undone.</span>
          </div>
        {/if}
        <div class="modal-action">
          <button class="btn btn-ghost" onclick={() => (showMergeModal = false)}>Cancel</button>
          <button
            class="btn btn-success gap-1"
            onclick={mergeBranch}
            disabled={merging || (selectedBranch.requires_approval && selectedBranch.review_status !== 'approved')}
          >
            {#if merging}<span class="loading loading-spinner loading-sm"></span>{:else}<Merge size={14} />{/if}
            Merge to Production
          </button>
        </div>
      {:else}
        <div class="space-y-3">
          {#if mergeResult.applied.length}
            <div>
              <p class="text-sm font-medium text-success mb-1 flex items-center gap-1"><CircleCheck size={14} /> Applied ({mergeResult.applied.length})</p>
              <ul class="list-disc list-inside text-sm">{#each mergeResult.applied as c}<li>{c}</li>{/each}</ul>
            </div>
          {/if}
          {#if mergeResult.errors.length}
            <div>
              <p class="text-sm font-medium text-error mb-1 flex items-center gap-1"><AlertCircle size={14} /> Errors ({mergeResult.errors.length})</p>
              <ul class="list-disc list-inside text-sm text-error">{#each mergeResult.errors as e}<li>{e}</li>{/each}</ul>
            </div>
          {/if}
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost" onclick={() => { showMergeModal = false; mergeResult = null; }}>Close</button>
        </div>
      {/if}
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showMergeModal = false)}></button>
  </dialog>
{/if}

<!-- Preview Token Modal -->
{#if previewToken}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-1 flex items-center gap-2"><Globe size={18} /> Preview Active</h3>
      <p class="text-sm opacity-70 mb-3">Use this token to query the isolated branch schema.</p>
      <div class="bg-base-200 rounded p-3 font-mono text-sm break-all select-all mb-2">{previewToken}</div>
      <p class="text-xs opacity-50 mb-4">Header: <span class="font-mono">X-Preview-Token: {previewToken}</span></p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => navigator.clipboard?.writeText(previewToken ?? '').then(() => toast.success('Copied!'))}>Copy</button>
        <button class="btn btn-ghost" onclick={() => { previewToken = null; previewBranch = null; }}>Close</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => { previewToken = null; previewBranch = null; }}></button>
  </dialog>
{/if}

<!-- Close Branch Confirmation -->
{#if deleteTarget}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-2">Close Branch</h3>
      <p class="text-sm opacity-70">Close "{deleteTarget.name}"? The branch schema and all its data will be deleted.</p>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (deleteTarget = null)}>Cancel</button>
        <button class="btn btn-error gap-1" onclick={closeBranch}><Trash2 size={14} /> Close Branch</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (deleteTarget = null)}></button>
  </dialog>
{/if}
