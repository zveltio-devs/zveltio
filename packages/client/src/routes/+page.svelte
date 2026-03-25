<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { LogIn, UserPlus } from '@lucide/svelte';

  let { data } = $props();

  const auth = useAuth();
  const theme = $derived(data?.theme ?? null);
  const nav = $derived((data?.nav ?? []) as any[]);
  const appName = $derived(theme?.app_name ?? import.meta.env.PUBLIC_APP_NAME ?? 'Portal');
</script>

<!-- If there are portal pages, the homepage is rendered via [slug]/+page  -->
<!-- This page only shows when no portal homepage is configured, as a fallback -->
<div class="min-h-screen flex items-center justify-center" style="background: var(--color-bg, #f9fafb)">
  <div class="text-center max-w-lg px-6">
    {#if theme?.logo_url}
      <img src={theme.logo_url} alt={appName} class="h-16 w-auto mx-auto mb-6"/>
    {/if}

    <h1 class="text-4xl font-bold mb-3" style="color: var(--color-text, #111827)">{appName}</h1>
    <p class="text-base opacity-60 mb-8" style="color: var(--color-text, #111827)">
      Welcome. Please sign in to continue.
    </p>

    {#if auth.isPending}
      <span class="loading loading-spinner loading-md" style="color: var(--color-primary, #6366f1)"></span>
    {:else if auth.isLoggedIn}
      <a href="/employee/dashboard"
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-white transition-opacity hover:opacity-90"
        style="background: var(--color-primary, #6366f1); border-radius: var(--radius, 0.5rem)">
        Go to Dashboard
      </a>
    {:else}
      <div class="flex gap-4 justify-center">
        <a href="/auth/login"
          class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-white transition-opacity hover:opacity-90"
          style="background: var(--color-primary, #6366f1); border-radius: var(--radius, 0.5rem)">
          <LogIn size={18}/> Sign In
        </a>
        <a href="/auth/signup"
          class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium border transition-colors hover:bg-black/5"
          style="color: var(--color-primary, #6366f1); border-color: var(--color-primary, #6366f1); border-radius: var(--radius, 0.5rem)">
          <UserPlus size={18}/> Create Account
        </a>
      </div>
    {/if}

    {#if nav.length > 0}
      <nav class="mt-8 flex gap-3 justify-center flex-wrap text-sm opacity-60">
        {#each nav as item}
          <a href="/{item.slug === '/' ? '' : item.slug}"
            class="hover:opacity-100 transition-opacity"
            style="color: var(--color-primary, #6366f1)">
            {item.title}
          </a>
        {/each}
      </nav>
    {/if}
  </div>
</div>
