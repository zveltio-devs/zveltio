<script lang="ts">
 import { onMount } from 'svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 let requests = $state<any[]>([]);
 let loading = $state(true);
 let filter = $state<'all' | 'pending' | 'approved' | 'rejected'>('all');

 onMount(async () => {
 await loadRequests();
 });

 async function loadRequests() {
 loading = true;
 try {
 const qs = filter !== 'all' ? `?status=${filter}` : '';
 const res = await fetch(`${engineUrl}/api/approvals${qs}`, { credentials: 'include' });
 const data = await res.json();
 requests = data.requests || [];
 } finally {
 loading = false;
 }
 }

 $effect(() => {
 filter; // reactive dependency
 loadRequests();
 });

 function statusBadge(status: string) {
 const map: Record<string, string> = {
 pending: 'badge-warning',
 approved: 'badge-success',
 rejected: 'badge-error',
 cancelled: 'badge-ghost',
 };
 return map[status] || 'badge-ghost';
 }

 async function decide(requestId: string, decision: 'approved' | 'rejected') {
 const comment = decision === 'rejected' ? prompt('Rejection reason (optional):') : undefined;

 await fetch(`${engineUrl}/api/approvals/${requestId}/decide`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ decision, comment }),
 });

 await loadRequests();
 }

 async function cancel(requestId: string) {
 if (!confirm('Cancel this approval request?')) return;
 await fetch(`${engineUrl}/api/approvals/${requestId}/cancel`, {
 method: 'POST',
 credentials: 'include',
 });
 await loadRequests();
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Approval Requests</h1>
 <p class="text-base-content/60 text-sm mt-1">Track and manage approval workflows</p>
 </div>
 <div class="flex gap-2">
 <a href="extensions/approvals/workflows" class="btn btn-ghost btn-sm">
 Workflows
 </a>
 </div>
 </div>

 <!-- Filters -->
 <div class="flex gap-2">
 {#each ['all', 'pending', 'approved', 'rejected'] as f}
 <button
 class="btn btn-sm {filter === f ? 'btn-primary' : 'btn-ghost'}"
 onclick={() => (filter = f as any)}
 >
 {f.charAt(0).toUpperCase() + f.slice(1)}
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-12">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
 {:else if requests.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <p class="text-base-content/60">No approval requests found</p>
 </div>
 {:else}
 <div class="space-y-3">
 {#each requests as request}
 <div class="card bg-base-200">
 <div class="card-body p-4">
 <div class="flex items-start justify-between gap-4">
 <div class="flex-1">
 <div class="flex items-center gap-2 mb-1">
 <span class="font-semibold">{request.workflow_name}</span>
 <span class="badge {statusBadge(request.status)} badge-sm">
 {request.status}
 </span>
 </div>
 <p class="text-sm text-base-content/60">
 {request.collection} / {request.record_id}
 </p>
 <p class="text-xs text-base-content/40 mt-1">
 Requested by {request.requested_by_name || 'unknown'}
 · {new Date(request.requested_at).toLocaleDateString()}
 </p>
 </div>

 {#if request.status === 'pending'}
 <div class="flex gap-2 shrink-0">
 <button
 class="btn btn-success btn-sm"
 onclick={() => decide(request.id, 'approved')}
 >
 Approve
 </button>
 <button
 class="btn btn-error btn-sm btn-outline"
 onclick={() => decide(request.id, 'rejected')}
 >
 Reject
 </button>
 <button
 class="btn btn-ghost btn-sm"
 onclick={() => cancel(request.id)}
 >
 Cancel
 </button>
 </div>
 {/if}
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>
