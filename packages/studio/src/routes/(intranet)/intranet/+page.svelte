<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import { SquareCheck, Bell, Clock, ArrowRight, User as UserIcon, FileText } from '@lucide/svelte';

  let notifications = $state<any[]>([]);
  let pendingTasks = $state<number>(0);
  let unreadCount = $state<number>(0);
  let zonePages = $state<{ slug: string; title: string; icon: string | null }[]>([]);
  let loading = $state(true);

  onMount(async () => {
    const [notifRes, tasksRes, zoneRes] = await Promise.allSettled([
      api.get<{ notifications: any[] }>('/api/notifications?unread_only=true'),
      api.get<{ tasks: any[] }>('/api/approvals?status=pending&assigned_to=me'),
      api.get<{ nav: any[] }>('/api/zones/intranet/render'),
    ]);
    if (notifRes.status === 'fulfilled') {
      notifications = (notifRes.value.notifications ?? []).slice(0, 5);
      unreadCount = notifRes.value.notifications?.length ?? 0;
    }
    if (tasksRes.status === 'fulfilled') pendingTasks = tasksRes.value.tasks?.length ?? 0;
    if (zoneRes.status === 'fulfilled') {
      zonePages = (zoneRes.value.nav ?? [])
        .filter((p: any) => !p.is_homepage)
        .map((p: any) => ({ slug: p.slug, title: p.title, icon: p.icon }));
    }
    loading = false;
  });

  // Quick-links point at REAL routes shipped by Studio (notifications, tasks,
  // profile) — never at slugs that don't exist in the zones DB. Anything that
  // depends on admin-configured zone pages is rendered separately below.
  const quickLinks = [
    { href: `${base}/intranet/tasks`,         icon: SquareCheck, label: 'My Tasks',       desc: 'Approvals & action items', badge: () => pendingTasks },
    { href: `${base}/intranet/notifications`, icon: Bell,        label: 'Notifications',  desc: 'Recent alerts & updates',  badge: () => unreadCount },
    { href: `${base}/intranet/profile`,       icon: UserIcon,    label: 'My Profile',     desc: 'View and edit your info',  badge: () => 0 },
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

  <!-- Quick access cards (built-in routes — never broken) -->
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
    {#each quickLinks as link}
      {@const count = link.badge()}
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
            {#if count > 0}
              <span class="badge badge-primary badge-sm font-medium">{count}</span>
            {:else}
              <ArrowRight size={14} class="text-base-content/30 group-hover:text-primary transition-colors" />
            {/if}
          </div>
          <p class="font-semibold text-sm text-base-content">{link.label}</p>
          <p class="text-xs text-base-content/50 mt-0.5">{link.desc}</p>
        </div>
      </a>
    {/each}
  </div>

  <!-- Zone pages — admin-configured pages from /api/zones/intranet/render -->
  {#if zonePages.length > 0}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-5">
        <h2 class="font-semibold text-sm mb-3 flex items-center gap-2">
          <FileText size={15} class="text-primary" />
          Pages
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {#each zonePages as p}
            <a href="{base}/intranet/{p.slug}"
              class="flex items-center gap-3 px-3 py-2 rounded-lg bg-base-100 hover:bg-base-300 transition-colors text-sm">
              {#if p.icon}<span class="text-base leading-none shrink-0">{p.icon}</span>{:else}<FileText size={14} class="text-base-content/40 shrink-0" />{/if}
              <span class="truncate">{p.title}</span>
              <ArrowRight size={12} class="text-base-content/30 ml-auto" />
            </a>
          {/each}
        </div>
      </div>
    </div>
  {/if}

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
