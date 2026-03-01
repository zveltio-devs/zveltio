<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import {
    CheckCircle, XCircle, Clock, Eye, X, AlertCircle, Check, Ban, RefreshCw,
  } from '@lucide/svelte';

  interface ApprovalRequest {
    id: string;
    workflow_name: string;
    collection: string;
    record_id: string;
    current_step_id: string | null;
    current_step_name: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    requester_name: string | null;
    requested_at: string;
    metadata: Record<string, any>;
  }

  interface ApprovalStep {
    id: string;
    step_order: number;
    name: string;
    approver_role: string | null;
    deadline_hours: number | null;
    decision: 'approved' | 'rejected' | 'skipped' | null;
    decider_name: string | null;
    comment: string | null;
  }

  let requests = $state<ApprovalRequest[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let activeTab = $state<'all' | 'pending' | 'my_pending' | 'completed'>('all');
  let selectedRequest = $state<ApprovalRequest | null>(null);
  let requestSteps = $state<ApprovalStep[]>([]);
  let showDetailModal = $state(false);
  let deciding = $state(false);
  let decisionComment = $state('');

  const tabs = [
    { key: 'all' as const, label: 'All' },
    { key: 'pending' as const, label: 'Pending' },
    { key: 'my_pending' as const, label: 'My Pending' },
    { key: 'completed' as const, label: 'Completed' },
  ];

  onMount(loadRequests);

  async function loadRequests() {
    loading = true;
    error = null;
    try {
      let endpoint = '/api/approvals?limit=50&offset=0';
      if (activeTab === 'pending') endpoint += '&status=pending';
      else if (activeTab === 'my_pending') endpoint += '&my_pending=true';
      else if (activeTab === 'completed') endpoint += '&status=approved,rejected,cancelled';

      const data = await api.get<{ requests: ApprovalRequest[]; total: number }>(endpoint);
      requests = data.requests || [];
      total = data.total || 0;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load approval requests';
    } finally {
      loading = false;
    }
  }

  function setTab(tab: typeof activeTab) {
    activeTab = tab;
    loadRequests();
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'pending': return { cls: 'badge-warning', text: 'Pending' };
      case 'approved': return { cls: 'badge-success', text: 'Approved' };
      case 'rejected': return { cls: 'badge-error', text: 'Rejected' };
      case 'cancelled': return { cls: 'badge-ghost', text: 'Cancelled' };
      default: return { cls: 'badge-ghost', text: status };
    }
  }

  async function openDetail(request: ApprovalRequest) {
    selectedRequest = request;
    showDetailModal = true;
    decisionComment = '';
    try {
      const data = await api.get<{ steps: ApprovalStep[] }>(`/api/approvals/${request.id}`);
      requestSteps = data.steps || [];
    } catch {
      requestSteps = [];
    }
  }

  function closeDetail() {
    showDetailModal = false;
    selectedRequest = null;
    requestSteps = [];
    decisionComment = '';
  }

  async function makeDecision(requestId: string, decision: 'approved' | 'rejected') {
    deciding = true;
    try {
      await api.post(`/api/approvals/${requestId}/decide`, {
        decision,
        comment: decisionComment || undefined,
      });
      await loadRequests();
      closeDetail();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to submit decision');
    } finally {
      deciding = false;
    }
  }

  async function cancelRequest(requestId: string) {
    if (!confirm('Cancel this request?')) return;
    try {
      await api.post(`/api/approvals/${requestId}/cancel`);
      await loadRequests();
      closeDetail();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to cancel request');
    }
  }

  function getStepStatus(step: ApprovalStep) {
    if (step.decision === 'approved') return 'approved';
    if (step.decision === 'rejected') return 'rejected';
    if (step.decision === 'skipped') return 'skipped';
    if (selectedRequest?.current_step_id === step.id) return 'current';
    return 'pending';
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleString();
  }

  function truncateId(id: string, length = 8) {
    return id.length <= length ? id : id.substring(0, length) + '…';
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Approval Requests</h1>
      <p class="text-base-content/60 text-sm mt-1">Manage approval workflows and requests</p>
    </div>
    <button class="btn btn-ghost btn-sm" onclick={loadRequests}><RefreshCw size={16} /></button>
  </div>

  <div class="tabs tabs-boxed bg-base-200 p-1">
    {#each tabs as tab}
      <button class="tab {activeTab === tab.key ? 'tab-active' : ''}" onclick={() => setTab(tab.key)}>
        {tab.label}
        {#if tab.key === 'my_pending' && activeTab === 'my_pending' && total > 0}
          <span class="badge badge-sm badge-primary ml-2">{total}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if error}
    <div class="alert alert-error"><AlertCircle size={20} /><span>{error}</span></div>
  {/if}

  <div class="card bg-base-100 shadow-sm">
    {#if loading}
      <div class="card-body text-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
    {:else if requests.length === 0}
      <div class="card-body text-center py-12">
        <CheckCircle size={48} class="mx-auto opacity-30" />
        <p class="mt-4 opacity-60">No approval requests found.</p>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-zebra">
          <thead>
            <tr>
              <th>Collection</th><th>Record ID</th><th>Workflow</th>
              <th>Step</th><th>Status</th><th>Requested By</th><th>Requested At</th><th></th>
            </tr>
          </thead>
          <tbody>
            {#each requests as request}
              {@const badge = getStatusBadge(request.status)}
              <tr class="hover cursor-pointer" onclick={() => openDetail(request)}>
                <td><span class="badge badge-ghost font-mono text-sm">{request.collection}</span></td>
                <td><span class="font-mono text-sm">{truncateId(request.record_id)}</span></td>
                <td>{request.workflow_name}</td>
                <td>{request.current_step_name || '—'}</td>
                <td><span class="badge {badge.cls} badge-sm">{badge.text}</span></td>
                <td>{request.requester_name || 'Unknown'}</td>
                <td class="text-sm opacity-60">{formatDate(request.requested_at)}</td>
                <td><button class="btn btn-ghost btn-sm btn-square"><Eye size={14} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

{#if showDetailModal && selectedRequest}
  {@const req = selectedRequest}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-bold text-lg">Approval Request Details</h3>
        <button class="btn btn-ghost btn-sm btn-square" onclick={closeDetail}><X size={16} /></button>
      </div>

      <div class="bg-base-200 rounded-lg p-4 mb-4 grid grid-cols-2 gap-3 text-sm">
        <div><span class="opacity-60">Collection:</span> <code class="ml-1">{req.collection}</code></div>
        <div><span class="opacity-60">Record:</span> <code class="ml-1">{req.record_id}</code></div>
        <div><span class="opacity-60">Workflow:</span> <span class="ml-1">{req.workflow_name}</span></div>
        <div>
          <span class="opacity-60">Status:</span>
          {@const badge = getStatusBadge(req.status)}
          <span class="badge {badge.cls} badge-sm ml-2">{badge.text}</span>
        </div>
        <div><span class="opacity-60">Requested By:</span> <span class="ml-1">{req.requester_name || 'Unknown'}</span></div>
        <div><span class="opacity-60">Created:</span> <span class="ml-1">{formatDate(req.requested_at)}</span></div>
      </div>

      <div class="mb-4">
        <h4 class="font-semibold mb-3 text-sm">Approval Steps</h4>
        <div class="space-y-2">
          {#each requestSteps as step, i}
            {@const status = getStepStatus(step)}
            <div class="flex items-center gap-3 p-3 rounded-lg border {status === 'current' ? 'border-primary bg-primary/5' : 'border-base-300'}">
              <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                {status === 'approved' ? 'bg-success text-success-content' :
                 status === 'rejected' ? 'bg-error text-error-content' :
                 status === 'current' ? 'bg-primary text-primary-content' : 'bg-base-300'}">
                {i + 1}
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-sm">{step.name}</div>
                <div class="text-xs opacity-60 mt-0.5 flex gap-2">
                  {#if step.approver_role}<span class="badge badge-xs badge-outline">{step.approver_role}</span>{/if}
                  {#if step.deadline_hours}<span>⏱ {step.deadline_hours}h</span>{/if}
                </div>
              </div>
              {#if step.decision}
                <span class="badge badge-sm {step.decision === 'approved' ? 'badge-success' : step.decision === 'rejected' ? 'badge-error' : 'badge-warning'}">{step.decision}</span>
              {/if}
              {#if step.decider_name}<span class="text-xs opacity-60">by {step.decider_name}</span>{/if}
            </div>
            {#if step.comment}
              <div class="ml-12 text-sm opacity-70 italic border-l-2 border-base-300 pl-3">"{step.comment}"</div>
            {/if}
          {:else}
            <div class="text-center py-4 opacity-60 text-sm">No steps loaded</div>
          {/each}
        </div>
      </div>

      {#if req.status === 'pending'}
        <div class="border-t border-base-300 pt-4 space-y-3">
          <div class="form-control">
            <label class="label" for="decision-comment"><span class="label-text text-sm">Comment (optional)</span></label>
            <textarea id="decision-comment" class="textarea textarea-bordered" placeholder="Add a comment..." bind:value={decisionComment} rows="2"></textarea>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-success flex-1 gap-2" onclick={() => makeDecision(req.id, 'approved')} disabled={deciding}>
              {#if deciding}<span class="loading loading-spinner loading-sm"></span>{:else}<Check size={14} />{/if}
              Approve
            </button>
            <button class="btn btn-error flex-1 gap-2" onclick={() => makeDecision(req.id, 'rejected')} disabled={deciding}>
              {#if deciding}<span class="loading loading-spinner loading-sm"></span>{:else}<X size={14} />{/if}
              Reject
            </button>
          </div>
          <div class="flex justify-end border-t border-base-300 pt-3">
            <button class="btn btn-ghost btn-sm text-error gap-1" onclick={() => cancelRequest(req.id)}>
              <Ban size={14} /> Cancel Request
            </button>
          </div>
        </div>
      {/if}
    </div>
    <button class="modal-backdrop" onclick={closeDetail}></button>
  </dialog>
{/if}
