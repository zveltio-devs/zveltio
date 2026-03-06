<script lang="ts">
  import { LayoutDashboard, LogOut, Menu } from '@lucide/svelte';
  import { useAuth } from '$stores/auth.svelte';

  let { data, children } = $props();
  const auth = useAuth();
  let drawerOpen = $state(false);
</script>

<div class="drawer lg:drawer-open">
  <input id="sidebar" type="checkbox" class="drawer-toggle" bind:checked={drawerOpen} />

  <div class="drawer-content">
    <!-- Navbar -->
    <div class="navbar bg-base-100 shadow-sm lg:hidden">
      <label for="sidebar" class="btn btn-ghost btn-square">
        <Menu size={20} />
      </label>
      <span class="flex-1 text-lg font-semibold px-2">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </span>
    </div>

    <!-- Page content -->
    <main class="p-4 lg:p-8">
      {@render children()}
    </main>
  </div>

  <!-- Sidebar -->
  <div class="drawer-side z-40">
    <label for="sidebar" class="drawer-overlay"></label>
    <aside class="bg-base-200 w-64 min-h-full p-4 flex flex-col">
      <div class="text-xl font-bold mb-6 px-2">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </div>

      <ul class="menu flex-1">
        <li>
          <a href="/employee/dashboard" class="gap-2">
            <LayoutDashboard size={18} />
            Dashboard
          </a>
        </li>
      </ul>

      <!-- User footer -->
      <div class="border-t border-base-300 pt-4 mt-4">
        <div class="flex items-center gap-3 px-2 mb-3">
          <div class="avatar placeholder">
            <div class="bg-primary text-primary-content rounded-full w-8">
              <span class="text-xs">{data.user?.name?.[0] ?? '?'}</span>
            </div>
          </div>
          <div class="text-sm">
            <div class="font-medium">{data.user?.name}</div>
            <div class="text-base-content/50 text-xs">{data.user?.email}</div>
          </div>
        </div>
        <button onclick={() => auth.signOut()} class="btn btn-ghost btn-sm w-full justify-start gap-2">
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  </div>
</div>
