<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import { CheckSquare, Bell, Database, Clock, ArrowRight } from '@lucide/svelte';

  let approvals = $state<any[]>([]);
  let notifications = $state<any[]>([]);
  let recentActivity = $state<any[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      const [notifRes] = await Promise.allSettled([
        api.get<{ notifications: any[] }>('/api/notifications?unread_only=true'),
      ]);
      if (notifRes.status === 'fulfilled') notifications = notifRes.value.notifications?.slice(0, 5) ?? [];
    } finally {
      loading = false;
    }
  });

  const quickLinks = [
    { href: `${base}/intranet/collections`, icon: Database,    label: 'Browse Data',     desc: 'Access company collections' },
    { href: `${base}/intranet/tasks`,       icon: CheckSquare, label: 'My Tasks',         desc: 'Pending approvals & actions' },
    { href: `${base}/intranet/notifications`,icon: Bell,       label: 'Notifications',   desc: 'Recent alerts & updates' },
  ];
</script>

<div class="space-y-8 max-w-4xl">

  <!-- Welcome header -->
  <div>
    <h1 class="text-2xl font-bold text-base-content">
      Welcome back, {auth.user?.name?.split(' ')[0] || 'there'} 👋
    </h1>
    <p class="text-base-content/50 text-sm mt-1">
      {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
    </p>
  </div>

  <!-- Quick access cards -->
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
    {#each quickLinks as link}
      <a
        href={link.href}
        class="group card bg-base-200 hover:bg-base-300 border border-base-300 hover:border-primary/30
          transition-all duration-150 hover:shadow-sm"
      >
        <div class="card-body p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <link.icon size={18} class="text-primary" />
            </div>
            <ArrowRight size={14} class="text-base-content/30 group-hover:text-primary transition-colors" />
          </div>
          <p class="font-semibold text-sm text-base-content">{link.label}</p>
          <p class="text-xs text-base-content/50 mt-0.5">{link.desc}</p>
        </div>
      </a>
    {/each}
  </div>

  <!-- Notifications -->
  <div class="card bg-base-200 border border-base-300">
    <div class="card-body p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-semibold text-sm flex items-center gap-2">
          <Bell size={15} class="text-primary" />
          Recent Notifications
        </h2>
        <a href="{base}/intranet/notifications" class="text-xs text-primary hover:underline">View all</a>
      </div>

      {#if loading}
        <div class="flex justify-center py-6">
          <span class="loading loading-spinner loading-sm text-primary"></span>
        </div>
      {:else if notifications.length === 0}
        <div class="text-center py-8 text-base-content/35">
          <Bell size={28} class="mx-auto mb-2 opacity-40" />
          <p class="text-sm">No unread notifications</p>
        </div>
      {:else}
        <div class="space-y-2">
          {#each notifications as n}
            <div class="flex items-start gap-3 p-3 rounded-lg bg-base-100 hover:bg-base-300 transition-colors">
              <div class="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0"></div>
              <div class="flex-1 min-w-0">
                <p class="text-sm text-base-content">{n.message || n.title || 'Notification'}</p>
                {#if n.created_at}
                  <p class="text-xs text-base-content/40 mt-0.5 flex items-center gap-1">
                    <Clock size={10} />
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Profile summary -->
  <div class="card bg-base-200 border border-base-300">
    <div class="card-body p-5">
      <h2 class="font-semibold text-sm mb-4">My Profile</h2>
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-full bg-primary text-primary-content flex items-center justify-center text-lg font-bold shrink-0">
          {auth.user?.name?.charAt(0).toUpperCase() || 'U'}
        </div>
        <div>
          <p class="font-semibold text-base-content">{auth.user?.name || 'User'}</p>
          <p class="text-sm text-base-content/50">{auth.user?.email}</p>
          <p class="text-xs text-base-content/35 mt-0.5 capitalize">{auth.user?.role || 'Employee'}</p>
        </div>
        <a href="{base}/intranet/profile" class="btn btn-outline btn-sm ml-auto">Edit Profile</a>
      </div>
    </div>
  </div>

</div>
