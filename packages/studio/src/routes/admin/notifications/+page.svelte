<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Bell, BellOff, CheckCheck, RefreshCw, Loader2 } from '@lucide/svelte';

  interface Notification {
    id: string;
    type: string;
    title: string;
    message: string;
    data: any;
    is_read: boolean;
    created_at: string;
  }

  let notifications = $state<Notification[]>([]);
  let loading = $state(true);
  let markingAll = $state(false);
  let unreadOnly = $state(false);

  const unreadCount = $derived(notifications.filter(n => !n.is_read).length);
  const filtered = $derived(unreadOnly ? notifications.filter(n => !n.is_read) : notifications);

  onMount(loadNotifications);

  async function loadNotifications() {
    loading = true;
    try {
      const params = unreadOnly ? '?unread_only=true' : '';
      const data = await api.get<{ notifications: Notification[] }>(`/api/admin/notifications${params}`);
      notifications = data.notifications || [];
    } catch { notifications = []; }
    finally { loading = false; }
  }

  async function markRead(id: string) {
    try {
      await api.patch(`/api/admin/notifications/${id}/read`, {});
      notifications = notifications.map(n => n.id === id ? { ...n, is_read: true } : n);
    } catch { /* silent */ }
  }

  async function markAllRead() {
    markingAll = true;
    try {
      await api.post('/api/admin/notifications/mark-all-read', {});
      notifications = notifications.map(n => ({ ...n, is_read: true }));
    } catch { /* silent */ }
    finally { markingAll = false; }
  }

  function typeClass(type: string): string {
    switch (type) {
      case 'error': return 'text-error';
      case 'warning': return 'text-warning';
      case 'success': return 'text-success';
      default: return 'text-info';
    }
  }

  function typeIcon(type: string): string {
    switch (type) {
      case 'error': return '✗';
      case 'warning': return '⚠';
      case 'success': return '✓';
      default: return 'ℹ';
    }
  }

  function fmt(s: string) {
    return new Date(s).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Notifications</h1>
      <p class="text-base-content/60 text-sm mt-1">
        {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
      </p>
    </div>
    <div class="flex gap-2">
      <label class="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={unreadOnly}
          onchange={loadNotifications} />
        Unread only
      </label>
      <button class="btn btn-ghost btn-sm" onclick={loadNotifications}>
        <RefreshCw size={15} />
      </button>
      {#if unreadCount > 0}
        <button class="btn btn-outline btn-sm" onclick={markAllRead} disabled={markingAll}>
          {#if markingAll}<Loader2 size={14} class="animate-spin" />{:else}<CheckCheck size={14} />{/if}
          Mark all read
        </button>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><Loader2 size={32} class="animate-spin text-primary" /></div>
  {:else if filtered.length === 0}
    <div class="text-center py-16 text-base-content/40">
      {#if unreadOnly}
        <CheckCheck size={48} class="mx-auto mb-3" />
        <p class="text-sm">All caught up! No unread notifications.</p>
      {:else}
        <BellOff size={48} class="mx-auto mb-3" />
        <p class="text-sm">No notifications yet.</p>
      {/if}
    </div>
  {:else}
    <div class="space-y-2">
      {#each filtered as notif}
        <div
          class="card bg-base-200 cursor-pointer hover:bg-base-300 transition-colors {!notif.is_read ? 'border-l-4 border-primary' : ''}"
          onclick={() => !notif.is_read && markRead(notif.id)}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && !notif.is_read && markRead(notif.id)}
        >
          <div class="card-body py-3 px-4">
            <div class="flex items-start gap-3">
              <span class="text-lg {typeClass(notif.type)} mt-0.5 font-bold shrink-0">
                {typeIcon(notif.type)}
              </span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <p class="font-medium text-sm {!notif.is_read ? '' : 'text-base-content/70'}">{notif.title}</p>
                  <span class="text-xs text-base-content/40 shrink-0">{fmt(notif.created_at)}</span>
                </div>
                <p class="text-sm text-base-content/60 mt-0.5">{notif.message}</p>
              </div>
              {#if !notif.is_read}
                <span class="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5"></span>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
