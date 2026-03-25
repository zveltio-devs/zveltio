<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { LogIn, UserPlus, LayoutDashboard } from '@lucide/svelte';

  const auth = useAuth();
</script>

<div class="hero min-h-screen bg-base-200">
  <div class="hero-content text-center">
    <div class="max-w-md">
      <h1 class="text-5xl font-bold">
        {import.meta.env.PUBLIC_APP_NAME || 'Zveltio'}
      </h1>
      <p class="py-6 text-base-content/70">
        Modern platform for data management, collaboration and automation.
      </p>

      {#if auth.isPending}
        <span class="loading loading-spinner loading-lg"></span>
      {:else if auth.isLoggedIn}
        <a href="/employee/dashboard" class="btn btn-primary gap-2">
          <LayoutDashboard size={20} />
          Go to Dashboard
        </a>
      {:else}
        <div class="flex gap-4 justify-center">
          <a href="/auth/login" class="btn btn-primary gap-2">
            <LogIn size={20} />
            Sign In
          </a>
          <a href="/auth/signup" class="btn btn-outline gap-2">
            <UserPlus size={20} />
            Create Account
          </a>
        </div>
      {/if}
    </div>
  </div>
</div>
