<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import {
  GitBranch,
  RefreshCw,
  Trash2,
  Eye,
  Merge,
  AlertCircle,
  CircleCheck,
  Clock,
  X,
  Globe,
  GlobeLock,
  ShieldCheck,
  ShieldX,
  MessageSquare,
} from '@lucide/svelte';
import CrudListPage from '$lib/components/common/CrudListPage.svelte';
import Modal from '$lib/components/common/Modal.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

interface SchemaBranch {
  id: string;
  name: string;
  description: string | null;
  base_schema: string;
  branch_schema: string;
  status: 'open' | 'merged' | 'closed';
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

let branches = $state<SchemaBranch[]>([]);
let loading = $state(true);
let showCreateModal = $state(false);
let newBranchName = $state('');
let newBranchDesc = $state('');
let creating = $state(false);

let showDiffModal = $state(false);
let selectedBranch = $state<SchemaBranch | null>(null);
let branchDiff = $state<Diff | null>(null);
let loadingDiff = $state(false);

let showMergeModal = $state(false);
let merging = $state(false);
let mergeResult = $state<{
  success: boolean;
  applied: string[];
  errors: string[];
  review_status?: string;
} | null>(null);

let deleteTarget = $state<SchemaBranch | null>(null);
let previewToken = $state<string | null>(null);
let previewBranch = $state<SchemaBranch | null>(null);
let enablingPreview = $state(false);

// Review panel
let showReviewModal = $state(false);
let reviewBranch = $state<SchemaBranch | null>(null);
let reviewStatus = $state<'approved' | 'rejected' | 'changes_requested'>('approved');
let reviewNote = $state('');
let submittingReview = $state(false);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let reviews = $state<any[]>([]);
let loadingReviews = $state(false);

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
    toast.error(e instanceof Error ? e.message : 'Failed to load diff');
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
    const result = await api.post<{
      success: boolean;
      applied: string[];
      errors: string[];
      review_status?: string;
    }>(`/api/schema/branches/${selectedBranch.id}/merge`);
    mergeResult = result;
    if (result.success) await loadBranches();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    // Approval gate returns 403 with structured error
    const body = e?.body ?? e;
    mergeResult = {
      success: false,
      applied: [],
      errors: [body?.error ?? (e instanceof Error ? e.message : 'Merge failed')],
      review_status: body?.review_status,
    };
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
  } finally {
    enablingPreview = false;
  }
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const res = await api.get<{ reviews: any[] }>(`/api/schema/branches/${branch.id}/reviews`);
    reviews = res.reviews ?? [];
  } catch {
    reviews = [];
  } finally {
    loadingReviews = false;
  }
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
  } finally {
    submittingReview = false;
  }
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
  return (
    { approved: 'badge-success', rejected: 'badge-error', changes_requested: 'badge-warning' }[
      status
    ] ?? 'badge-ghost'
  );
}

function statusBadge(status: string) {
  return (
    { open: 'badge-info', merged: 'badge-success', closed: 'badge-ghost' }[status] ?? 'badge-ghost'
  );
}

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleString() : '—';
}
</script>

<CrudListPage
  title={m['schemaBranches.title']()}
  subtitle={m['schemaBranches.subtitle']()}
  count={branches.length}
  {loading}
  actionLabel={m['schemaBranches.createBranch']()}
  onAction={() => (showCreateModal = true)}
  empty={{
    illustration: 'target',
    illustrationColor: 'text-primary',
    title: m['schemaBranches.emptyTitle'](),
    description: m['schemaBranches.emptyDesc'](),
    actionLabel: m['schemaBranches.createBranch'](),
    onAction: () => (showCreateModal = true),
  }}
>
  {#snippet headerExtras()}
    <div class="flex items-center justify-between gap-3 -mt-2">
      <div class="alert alert-info flex-1">
        <AlertCircle size={16} />
        <span class="text-sm">{m['schemaBranches.infoBanner']()}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-sm shrink-0" onclick={loadBranches} disabled={loading} aria-label={m['schemaBranches.refresh']()}>
        <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  {/snippet}

  {#snippet list()}
    <div class="card bg-base-100 shadow-sm overflow-x-auto">
      <table class="table">
        <thead>
          <tr>
            <th>{m['schemaBranches.colBranch']()}</th>
            <th>{m['common.col.status']()}</th>
            <th>{m['schemaBranches.review']()}</th>
            <th>{m['schemaBranches.approvalRequired']()}</th>
            <th>{m['schemaBranches.colChanges']()}</th>
            <th>{m['common.col.created']()}</th>
            <th class="text-right">{m['common.actions']()}</th>
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
                  <span class="text-xs text-base-content/55">{m['schemaBranches.none']()}</span>
                {/if}
              </td>
              <td>
                {#if branch.status === 'open'}
                  <input
                    type="checkbox"
                    class="toggle toggle-xs toggle-warning"
                    checked={branch.requires_approval}
                    onchange={() => toggleRequiresApproval(branch)}
                    title={m['schemaBranches.requireBeforeMerge']()}
                  />
                {:else}
                  <span class="text-xs text-base-content/55">—</span>
                {/if}
              </td>
              <td class="text-sm opacity-60">{branch.changes?.length || 0}</td>
              <td class="text-sm opacity-60">{fmt(branch.created_at)}</td>
              <td>
                <div class="flex items-center justify-end gap-1">
                  <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={() => viewDiff(branch)} title={m['schemaBranches.viewDiff']()}>
                    <Eye size={12} /> Diff
                  </button>

                  {#if branch.status === 'open'}
                    <!-- Preview -->
                    {#if branch.preview_enabled}
                      <button type="button" class="btn btn-info btn-xs gap-1" onclick={() => { previewToken = branch.preview_token ?? null; previewBranch = branch; }} title={m['schemaBranches.showPreviewToken']()}>
                        <Globe size={12} />
                      </button>
                      <button type="button" class="btn btn-ghost btn-xs text-warning" onclick={() => disablePreview(branch)} title={m['schemaBranches.disablePreview']()}>
                        <GlobeLock size={12} />
                      </button>
                    {:else}
                      <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={() => enablePreview(branch)} disabled={enablingPreview} title={m['schemaBranches.enablePreview']()}>
                        <Globe size={12} />
                      </button>
                    {/if}

                    <!-- Review -->
                    <button type="button" class="btn btn-ghost btn-xs gap-1" onclick={() => openReviewModal(branch)} title={m['schemaBranches.submitReview']()}>
                      <MessageSquare size={12} /> {m['schemaBranches.review']()}
                    </button>

                    <!-- Merge -->
                    <button type="button"
                      class="btn btn-success btn-xs gap-1"
                      onclick={() => openMergeModal(branch)}
                      title={branch.requires_approval && branch.review_status !== 'approved' ? m['schemaBranches.approvalBeforeMerge']() : m['schemaBranches.mergeToProduction']()}
                    >
                      <Merge size={12} /> {m['schemaBranches.merge']()}
                    </button>

                    <button type="button" class="btn btn-ghost btn-xs text-error" onclick={() => (deleteTarget = branch)} title={m['schemaBranches.closeBranch']()}>
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
  {/snippet}
</CrudListPage>

<!-- Create Modal -->
{#if showCreateModal}
  <Modal bind:open={showCreateModal} title={m['schemaBranches.createModalTitle']()} size="md" onSubmit={createBranch}>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label" for="branch-name"><span class="label-text">{m['schemaBranches.branchName']()}</span></label>
          <input id="branch-name" type="text" bind:value={newBranchName} placeholder="add-user-settings" class="input" />
        </div>
        <div class="form-control">
          <label class="label" for="branch-desc"><span class="label-text">{m['common.col.description']()}</span></label>
          <textarea id="branch-desc" bind:value={newBranchDesc} rows="2" placeholder={m['schemaBranches.branchDescPlaceholder']()} class="textarea"></textarea>
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (showCreateModal = false)}>{m['common.cancel']()}</button>
        <button type="submit" class="btn btn-primary" disabled={!newBranchName.trim() || creating}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          {m['common.create']()}
        </button>
      </div>
  </Modal>
{/if}

<!-- Diff Modal -->
{#if showDiffModal && selectedBranch}
  <Modal bind:open={showDiffModal} title={m['schemaBranches.diffTitle']({ name: selectedBranch.name })} size="lg">
      {#if loadingDiff}
        <div class="flex justify-center py-8"><span class="loading loading-spinner loading-md"></span></div>
      {:else if branchDiff}
        <div class="space-y-4">
          {#if branchDiff.collections_added.length}
            <div>
              <p class="text-sm font-medium text-success mb-1">{m['schemaBranches.addedCollections']()} ({branchDiff.collections_added.length})</p>
              <ul class="list-disc list-inside text-sm font-mono space-y-0.5">
                {#each branchDiff.collections_added as c}<li>{c}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if branchDiff.collections_removed.length}
            <div>
              <p class="text-sm font-medium text-error mb-1">{m['schemaBranches.removedCollections']()} ({branchDiff.collections_removed.length})</p>
              <ul class="list-disc list-inside text-sm font-mono space-y-0.5">
                {#each branchDiff.collections_removed as c}<li>{c}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if branchDiff.fields_modified.length}
            <div>
              <p class="text-sm font-medium text-warning mb-1">{m['schemaBranches.modifiedFields']()} ({branchDiff.fields_modified.length})</p>
              <ul class="list-disc list-inside text-sm font-mono space-y-0.5">
                {#each branchDiff.fields_modified as f}<li>{f}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if !branchDiff.collections_added.length && !branchDiff.collections_removed.length && !branchDiff.fields_modified.length}
            <p class="text-sm opacity-50 text-center py-4">{m['schemaBranches.noChanges']()}</p>
          {/if}
        </div>
      {/if}
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (showDiffModal = false)}>{m['common.close']()}</button>
      </div>
  </Modal>
{/if}

<!-- Review Modal -->
{#if showReviewModal && reviewBranch}
  <Modal bind:open={showReviewModal} title={m['schemaBranches.reviewTitle']({ name: reviewBranch.name })} size="md">

      <!-- Past reviews -->
      {#if loadingReviews}
        <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
      {:else if reviews.length > 0}
        <div class="mb-4 space-y-2">
          <p class="text-xs font-semibold text-base-content/65 uppercase tracking-wide">{m['schemaBranches.reviewHistory']()}</p>
          {#each reviews as r}
            <div class="flex items-start gap-2 bg-base-200 rounded p-2 text-sm">
              <span class="badge badge-xs {reviewBadge(r.status)} mt-0.5">{r.status?.replace('_', ' ')}</span>
              <div class="flex-1 min-w-0">
                {#if r.reviewer_note}<p class="text-xs text-base-content/70">{r.reviewer_note}</p>{/if}
                <p class="text-xs text-base-content/55">{fmt(r.reviewed_at ?? r.created_at)}</p>
              </div>
            </div>
          {/each}
        </div>
        <div class="divider my-2"></div>
      {/if}

      <!-- New review form -->
      <div class="space-y-3">
        <p class="text-sm font-medium">{m['schemaBranches.submitNewReview']()}</p>
        <div class="flex gap-2">
          <button type="button"
            class="btn btn-sm flex-1 gap-1 {reviewStatus === 'approved' ? 'btn-success' : 'btn-ghost'}"
            onclick={() => (reviewStatus = 'approved')}
          >
            <ShieldCheck size={14} /> {m['common.approve']()}
          </button>
          <button type="button"
            class="btn btn-sm flex-1 gap-1 {reviewStatus === 'changes_requested' ? 'btn-warning' : 'btn-ghost'}"
            onclick={() => (reviewStatus = 'changes_requested')}
          >
            <MessageSquare size={14} /> {m['schemaBranches.requestChanges']()}
          </button>
          <button type="button"
            class="btn btn-sm flex-1 gap-1 {reviewStatus === 'rejected' ? 'btn-error' : 'btn-ghost'}"
            onclick={() => (reviewStatus = 'rejected')}
          >
            <ShieldX size={14} /> {m['common.reject']()}
          </button>
        </div>
        <div class="form-control">
          <label class="label" for="review-note"><span class="label-text text-xs">{m['schemaBranches.noteOptional']()}</span></label>
          <textarea id="review-note" bind:value={reviewNote} class="textarea textarea-sm" rows="2" placeholder={m['schemaBranches.addComment']()}></textarea>
        </div>
      </div>

      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (showReviewModal = false)}>{m['common.cancel']()}</button>
        <button type="button" class="btn btn-primary" onclick={submitReview} disabled={submittingReview}>
          {#if submittingReview}<span class="loading loading-spinner loading-sm"></span>{/if}
          {m['schemaBranches.submitReview']()}
        </button>
      </div>
  </Modal>
{/if}

<!-- Merge Modal -->
{#if showMergeModal && selectedBranch}
  <Modal bind:open={showMergeModal} title={m['schemaBranches.mergeTitle']({ name: selectedBranch.name })} size="md">
      {#if !mergeResult}
        {#if selectedBranch.requires_approval && selectedBranch.review_status !== 'approved'}
          <div class="alert alert-warning mb-4">
            <AlertCircle size={16} />
            <span class="text-sm">{m['schemaBranches.requiresApprovedReview']()} <strong>{selectedBranch.review_status ?? m['schemaBranches.none']()}</strong></span>
          </div>
        {:else}
          <div class="alert alert-warning mb-4">
            <AlertCircle size={16} />
            <span class="text-sm">{m['schemaBranches.mergeWarning']({ count: selectedBranch.changes?.length || 0 })}</span>
          </div>
        {/if}
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" onclick={() => (showMergeModal = false)}>{m['common.cancel']()}</button>
          <button type="button"
            class="btn btn-success gap-1"
            onclick={mergeBranch}
            disabled={merging || (selectedBranch.requires_approval && selectedBranch.review_status !== 'approved')}
          >
            {#if merging}<span class="loading loading-spinner loading-sm"></span>{:else}<Merge size={14} />{/if}
            {m['schemaBranches.mergeToProduction']()}
          </button>
        </div>
      {:else}
        <div class="space-y-3">
          {#if mergeResult.applied.length}
            <div>
              <p class="text-sm font-medium text-success mb-1 flex items-center gap-1"><CircleCheck size={14} /> {m['schemaBranches.applied']()} ({mergeResult.applied.length})</p>
              <ul class="list-disc list-inside text-sm">{#each mergeResult.applied as c}<li>{c}</li>{/each}</ul>
            </div>
          {/if}
          {#if mergeResult.errors.length}
            <div>
              <p class="text-sm font-medium text-error mb-1 flex items-center gap-1"><AlertCircle size={14} /> {m['schemaBranches.errors']()} ({mergeResult.errors.length})</p>
              <ul class="list-disc list-inside text-sm text-error">{#each mergeResult.errors as e}<li>{e}</li>{/each}</ul>
            </div>
          {/if}
        </div>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" onclick={() => { showMergeModal = false; mergeResult = null; }}>{m['common.close']()}</button>
        </div>
      {/if}
  </Modal>
{/if}

<!-- Preview Token Modal -->
{#if previewToken}
  <Modal open={true} title={m['schemaBranches.previewActive']()} size="md" dismissible={false}>
      <p class="text-sm opacity-70 mb-3">{m['schemaBranches.previewTokenDesc']()}</p>
      <div class="bg-base-200 rounded p-3 font-mono text-sm break-all select-all mb-2">{previewToken}</div>
      <p class="text-xs opacity-50 mb-4">{m['schemaBranches.headerLabel']()} <span class="font-mono">X-Preview-Token: {previewToken}</span></p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => navigator.clipboard?.writeText(previewToken ?? '').then(() => toast.success('Copied!'))}>{m['common.copyShort']()}</button>
        <button type="button" class="btn btn-ghost" onclick={() => { previewToken = null; previewBranch = null; }}>{m['common.close']()}</button>
      </div>
  </Modal>
{/if}

<!-- Close Branch Confirmation -->
{#if deleteTarget}
  <Modal open={true} title={m['schemaBranches.closeBranch']()} size="md" dismissible={false}>
      <p class="text-sm opacity-70">{m['schemaBranches.closeConfirm']({ name: deleteTarget.name })}</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (deleteTarget = null)}>{m['common.cancel']()}</button>
        <button type="button" class="btn btn-error gap-1" onclick={closeBranch}><Trash2 size={14} /> {m['schemaBranches.closeBranch']()}</button>
      </div>
  </Modal>
{/if}
