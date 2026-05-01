<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { SquareCheck, Clock, ArrowRight, Inbox } from '@lucide/svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  let tasks = $state<any[]>([]);
  let loading = $state(true);
  let busy = $state<string | null>(null);

  async function load() {
    loading = true;
    try {
      // The approvals extension exposes /api/approvals; if not installed we
      // fall back to empty so the page degrades gracefully.
      const res = await api.get<{ tasks?: any[]; approvals?: any[] }>('/api/approvals?status=pending&assigned_to=me');
      tasks = res.tasks ?? res.approvals ?? [];
    } catch {
      tasks = [];
    } finally {
      loading = false;
    }
  }

  async function approve(id: string) {
    busy = id;
    try {
      await api.post(`/api/approvals/${id}/approve`, {});
      toast.success('Approved');
      await load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to approve');
    } finally {
      busy = null;
    }
  }

  async function reject(id: string) {
    busy = id;
    try {
      await api.post(`/api/approvals/${id}/reject`, {});
      toast.success('Rejected');
      await load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to reject');
    } finally {
      busy = null;
    }
  }

  onMount(load);
</script>

<div class="space-y-5 max-w-3xl">

  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2">
      <SquareCheck size={18} class="text-primary" /> My Tasks
    </h1>
    <p class="text-sm text-base-content/50 mt-0.5">Pending approvals and items assigned to you.</p>
  </div>

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-md text-primary"></span>
    </div>
  {:else if tasks.length === 0}
    <div class="text-center py-16 text-base-content/35">
      <Inbox size={40} class="mx-auto mb-3 opacity-40" strokeWidth={1.3} />
      <p class="text-base font-medium">Nothing on your plate</p>
      <p class="text-sm mt-1">Approvals and tasks assigned to you will appear here.</p>
    </div>
  {:else}
    <div class="space-y-2">
      {#each tasks as t (t.id)}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4 gap-3">
            <div class="flex items-start gap-3">
              <div class="flex-1 min-w-0">
                <p class="font-medium text-sm">{t.title ?? t.name ?? `Task ${(t.id as string)?.slice(0,8) ?? ''}`}</p>
                {#if t.description}
                  <p class="text-sm text-base-content/60 mt-0.5">{t.description}</p>
                {/if}
                <p class="text-xs text-base-content/40 mt-1.5 flex items-center gap-1">
                  <Clock size={10} />
                  {new Date(t.created_at ?? Date.now()).toLocaleString()}
                </p>
              </div>
              <span class="badge badge-warning badge-sm shrink-0">{t.status ?? 'pending'}</span>
            </div>
            <div class="flex gap-2 justify-end">
              <button class="btn btn-ghost btn-xs gap-1 text-error"
                onclick={() => reject(t.id)} disabled={busy === t.id}>
                Reject
              </button>
              <button class="btn btn-primary btn-xs gap-1"
                onclick={() => approve(t.id)} disabled={busy === t.id}>
                Approve <ArrowRight size={11} />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
