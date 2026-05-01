<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Bell, Check, Clock, Trash2 } from '@lucide/svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  let notifications = $state<any[]>([]);
  let loading = $state(true);
  let filter = $state<'all' | 'unread'>('unread');
  let busy = $state<string | null>(null);

  async function load() {
    loading = true;
    try {
      const qs = filter === 'unread' ? '?unread_only=true' : '';
      const res = await api.get<{ notifications: any[] }>(`/api/notifications${qs}`);
      notifications = res.notifications ?? [];
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to load notifications');
    } finally {
      loading = false;
    }
  }

  async function markRead(id: string) {
    busy = id;
    try {
      await api.patch(`/api/notifications/${id}`, { read: true });
      await load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to mark as read');
    } finally {
      busy = null;
    }
  }

  async function markAllRead() {
    busy = 'all';
    try {
      await api.post('/api/notifications/mark-all-read', {});
      await load();
      toast.success('All notifications marked as read');
    } catch (e: any) {
      toast.error(e.message ?? 'Failed');
    } finally {
      busy = null;
    }
  }

  async function remove(id: string) {
    busy = id;
    try {
      await api.delete(`/api/notifications/${id}`);
      await load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to delete');
    } finally {
      busy = null;
    }
  }

  $effect(() => {
    // Re-fetch whenever the filter changes
    void filter;
    load();
  });

  onMount(load);
</script>

<div class="space-y-5 max-w-3xl">

  <div class="flex items-end justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2">
        <Bell size={18} class="text-primary" /> Notifications
      </h1>
      <p class="text-sm text-base-content/50 mt-0.5">Alerts, mentions and system updates.</p>
    </div>
    <button class="btn btn-ghost btn-sm gap-1.5"
      onclick={markAllRead}
      disabled={busy === 'all' || notifications.every(n => n.read)}>
      <Check size={14} /> Mark all as read
    </button>
  </div>

  <!-- Filter tabs -->
  <div role="tablist" class="tabs tabs-boxed bg-base-200 w-fit">
    <button role="tab" class="tab {filter === 'unread' ? 'tab-active' : ''}"
      onclick={() => (filter = 'unread')}>Unread</button>
    <button role="tab" class="tab {filter === 'all' ? 'tab-active' : ''}"
      onclick={() => (filter = 'all')}>All</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-md text-primary"></span>
    </div>
  {:else if notifications.length === 0}
    <div class="text-center py-16 text-base-content/35">
      <Bell size={40} class="mx-auto mb-3 opacity-40" strokeWidth={1.3} />
      <p class="text-base font-medium">{filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}</p>
      <p class="text-sm mt-1">
        {filter === 'unread' ? 'You\'re all caught up.' : 'Notifications will appear here when something needs your attention.'}
      </p>
    </div>
  {:else}
    <div class="space-y-2">
      {#each notifications as n (n.id)}
        <div class="card bg-base-200 border border-base-300
          {n.read ? 'opacity-75' : 'border-primary/20'}">
          <div class="card-body p-4 gap-2">
            <div class="flex items-start gap-3">
              {#if !n.read}
                <div class="w-2 h-2 rounded-full bg-primary mt-2 shrink-0"></div>
              {:else}
                <div class="w-2 h-2 mt-2 shrink-0"></div>
              {/if}
              <div class="flex-1 min-w-0">
                {#if n.title}
                  <p class="font-medium text-sm">{n.title}</p>
                {/if}
                <p class="text-sm text-base-content/70 mt-0.5">
                  {n.message ?? n.body ?? '—'}
                </p>
                <p class="text-xs text-base-content/40 mt-1.5 flex items-center gap-1">
                  <Clock size={10} />
                  {new Date(n.created_at).toLocaleString()}
                </p>
              </div>
              <div class="flex gap-1 shrink-0">
                {#if !n.read}
                  <button class="btn btn-ghost btn-xs btn-square"
                    onclick={() => markRead(n.id)}
                    disabled={busy === n.id}
                    aria-label="Mark as read"
                    title="Mark as read">
                    <Check size={12} />
                  </button>
                {/if}
                <button class="btn btn-ghost btn-xs btn-square text-error"
                  onclick={() => remove(n.id)}
                  disabled={busy === n.id}
                  aria-label="Delete"
                  title="Delete">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
