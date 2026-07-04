<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { CheckSquare, Workflow, LoaderCircle } from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

let tab = $state<'approvals' | 'workflows'>('approvals');
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let requests = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let workflows = $state<any[]>([]);
let loading = $state(true);
let filter = $state<'all' | 'pending' | 'approved' | 'rejected'>('all');

async function loadRequests() {
  loading = true;
  try {
    const qs = filter !== 'all' ? `?status=${filter}` : '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ requests: any[] }>(`/api/approvals${qs}`);
    requests = data.requests ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function loadWorkflows() {
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ workflows: any[] }>('/ext/workflow/approvals/workflows');
    workflows = data.workflows ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function decide(requestId: string, decision: 'approved' | 'rejected') {
  const comment =
    decision === 'rejected' ? (prompt('Rejection reason (optional):') ?? undefined) : undefined;
  try {
    await api.post(`/ext/workflow/approvals/${requestId}/decide`, { decision, comment });
    await loadRequests();
    toast.success(decision === 'approved' ? 'Approved.' : 'Rejected.');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

async function cancel(requestId: string) {
  askConfirm(m['workflow.approvals.confirmCancel'](), () => cancelConfirmed(requestId));
}
async function cancelConfirmed(requestId: string) {
  try {
    await api.post(`/ext/workflow/approvals/${requestId}/cancel`, {});
    await loadRequests();
    toast.success(m['workflow.approvals.toast.cancelled']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

$effect(() => {
  if (tab === 'approvals') loadRequests();
  else loadWorkflows();
});
$effect(() => {
  filter;
  if (tab === 'approvals') loadRequests();
});

function statusBadge(s: string) {
  return (
    (
      {
        pending: 'badge-warning',
        approved: 'badge-success',
        rejected: 'badge-error',
        cancelled: 'badge-ghost',
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } as any
    )[s] ?? 'badge-ghost'
  );
}
</script>

<ExtensionPageShell title={m['workflow.approvals.title']()} subtitle={m['workflow.approvals.subtitle']()}>
<div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'approvals' ? 'tab-active' : ''}" onclick={() => (tab = 'approvals')}>
      <CheckSquare size={13} class="mr-1.5" aria-hidden="true" /> {m['workflow.approvals.tab.requests']()}
    </button>
    <button class="tab {tab === 'workflows' ? 'tab-active' : ''}" onclick={() => (tab = 'workflows')}>
      <Workflow size={13} class="mr-1.5" /> {m['workflow.approvals.tab.workflowsLabel']()}
    </button>
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'approvals'}
    <div class="flex gap-2">
      {#each ['all', 'pending', 'approved', 'rejected'] as f}
        <button class="btn btn-sm {filter === f ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = f as any)}>
          {f.charAt(0).toUpperCase() + f.slice(1)}
        </button>
      {/each}
    </div>

    {#if requests.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center py-12 text-base-content/50 text-sm">{m['workflow.approvals.empty.requests']()}</div>
      </div>
    {:else}
      <div class="space-y-3">
        {#each requests as r (r.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4">
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="font-medium text-sm">{r.workflow_name}</span>
                    <span class="badge {statusBadge(r.status)} badge-sm">{r.status}</span>
                  </div>
                  <p class="text-xs text-base-content/60">{r.collection} / {r.record_id}</p>
                  <p class="text-xs text-base-content/40 mt-1">
                    Requested by {r.requested_by_name || 'unknown'} · {new Date(r.requested_at).toLocaleDateString()}
                  </p>
                </div>
                {#if r.status === 'pending'}
                  <div class="flex gap-2 shrink-0">
                    <button class="btn btn-success btn-sm" onclick={() => decide(r.id, 'approved')}>{m['common.approve']()}</button>
                    <button class="btn btn-error btn-sm btn-outline" onclick={() => decide(r.id, 'rejected')}>{m['common.reject']()}</button>
                    <button class="btn btn-ghost btn-sm" onclick={() => cancel(r.id)}>{m['common.cancel']()}</button>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    {#if workflows.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center py-12 text-base-content/50 text-sm">{m['workflow.approvals.empty.workflows']()}</div>
      </div>
    {:else}
      <div class="space-y-2">
        {#each workflows as w (w.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3 flex-row items-center gap-3">
              <Workflow size={16} class="text-primary shrink-0" />
              <div class="flex-1">
                <p class="font-medium text-sm">{w.name}</p>
                <p class="text-xs text-base-content/50">{w.collection} · {w.steps?.length ?? 0} step(s)</p>
              </div>
              <span class="badge badge-sm {w.is_active ? 'badge-success' : 'badge-ghost'}">{w.is_active ? m['common.col.active']() : 'Inactive'}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

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
