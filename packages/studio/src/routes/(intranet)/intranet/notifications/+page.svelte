<script lang="ts">
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { Bell, BellOff, BellRing, Check, Clock, Trash2 } from '@lucide/svelte';
import { toast } from '$lib/stores/toast.svelte.js';
import {
  subscribeToWebPush,
  unsubscribeFromWebPush,
  webPushStatus,
  type WebPushState,
} from '$lib/web-push.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let notifications = $state<any[]>([]);
let loading = $state(true);
let filter = $state<'all' | 'unread'>('unread');
let busy = $state<string | null>(null);

// Browser push. Four of the five states are "off" for different reasons, and
// only one of them is something the person looking at this page can change —
// so the button says which.
let pushState = $state<WebPushState | 'loading'>('loading');
let pushBusy = $state(false);

async function togglePush() {
  pushBusy = true;
  try {
    pushState =
      pushState === 'subscribed' ? await unsubscribeFromWebPush() : await subscribeToWebPush();
    if (pushState === 'subscribed') toast.success('Browser notifications are on');
    if (pushState === 'denied') {
      toast.error('Your browser is blocking notifications for this site');
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e.message ?? 'Could not change notification settings');
  } finally {
    pushBusy = false;
  }
}

async function load() {
  loading = true;
  try {
    const qs = filter === 'unread' ? '?unread_only=true' : '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const res = await api.get<{ notifications: any[] }>(`/api/notifications${qs}`);
    notifications = res.notifications ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (e: any) {
    toast.error(e.message ?? 'Failed to load notifications');
  } finally {
    loading = false;
  }
}

async function markRead(id: string) {
  busy = id;
  try {
    await api.patch(`/api/notifications/${id}/read`, {});
    await load();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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

onMount(async () => {
  await load();
  // Never throws at the page: a browser without the Push API, or an engine
  // without VAPID keys, is a button that explains itself, not an error toast.
  pushState = await webPushStatus().catch(() => 'unsupported' as const);
});
</script>

<div class="space-y-5 max-w-3xl">

  <div class="flex items-end justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2">
        <Bell size={18} class="text-primary" /> Notifications
      </h1>
      <p class="text-sm text-base-content/65 mt-0.5">Alerts, mentions and system updates.</p>
    </div>
    <div class="flex items-center gap-1.5">
      {#if pushState !== 'loading' && pushState !== 'unsupported'}
        <button class="btn btn-ghost btn-sm gap-1.5"
          onclick={togglePush}
          disabled={pushBusy || pushState === 'disabled-on-server' || pushState === 'denied'}
          title={pushState === 'disabled-on-server'
            ? 'The server has no Web Push keys configured'
            : pushState === 'denied'
              ? 'Blocked in your browser settings for this site'
              : pushState === 'subscribed'
                ? 'Stop receiving notifications in this browser'
                : 'Also receive these in this browser, even when the tab is closed'}>
          {#if pushState === 'subscribed'}
            <BellRing size={14} class="text-primary" /> Browser push on
          {:else if pushState === 'denied'}
            <BellOff size={14} /> Blocked by browser
          {:else if pushState === 'disabled-on-server'}
            <BellOff size={14} /> Push not configured
          {:else}
            <Bell size={14} /> Enable browser push
          {/if}
        </button>
      {/if}
      <button class="btn btn-ghost btn-sm gap-1.5"
        onclick={markAllRead}
        disabled={busy === 'all' || notifications.every(n => n.is_read)}>
        <Check size={14} /> Mark all as read
      </button>
    </div>
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
    <div class="text-center py-16 text-base-content/65">
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
          {n.is_read ? 'opacity-75' : 'border-primary/20'}">
          <div class="card-body p-4 gap-2">
            <div class="flex items-start gap-3">
              {#if !n.is_read}
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
                <p class="text-xs text-base-content/65 mt-1.5 flex items-center gap-1">
                  <Clock size={10} />
                  {new Date(n.created_at).toLocaleString()}
                </p>
              </div>
              <div class="flex gap-1 shrink-0">
                {#if !n.is_read}
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
