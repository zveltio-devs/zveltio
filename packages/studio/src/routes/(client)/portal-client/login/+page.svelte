<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { auth } from '$lib/auth.svelte.js';
  import { api } from '$lib/api.js';
  import { LoaderCircle } from '@lucide/svelte';

  let email = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state('');
  let portalName = $state('Client Portal');

  onMount(async () => {
    try {
      const res = await api.get<{ config: any }>('/api/portal-client/config');
      if (res.config?.site_name) portalName = res.config.site_name;
    } catch {}
    await auth.init();
    if (auth.isAuthenticated) goto(`${base}/portal-client/dashboard`);
  });

  async function login() {
    if (!email.trim() || !password) return;
    loading = true; error = '';
    try {
      await auth.signIn(email.trim(), password);
      goto(`${base}/portal-client/dashboard`);
    } catch (e: any) {
      error = e.message || 'Invalid email or password';
    } finally { loading = false; }
  }
</script>

<div class="min-h-screen bg-base-100 flex items-center justify-center p-4">
  <div class="w-full max-w-sm">

    <!-- Logo / Header -->
    <div class="text-center mb-8">
      <div class="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center mx-auto mb-4">
        <span class="text-primary-content font-bold text-xl">{portalName[0]?.toUpperCase() ?? 'P'}</span>
      </div>
      <h1 class="text-2xl font-bold text-base-content">{portalName}</h1>
      <p class="text-sm text-base-content/50 mt-1">Sign in to your account</p>
    </div>

    <!-- Form -->
    <div class="card bg-base-200 border border-base-300 shadow-sm">
      <div class="card-body p-6 gap-4">
        {#if error}
          <div class="alert alert-error text-sm py-2">
            <span>{error}</span>
          </div>
        {/if}

        <div class="form-control gap-1">
          <label class="label py-0" for="email">
            <span class="label-text text-xs font-medium">Email address</span>
          </label>
          <input
            id="email"
            type="email"
            bind:value={email}
            placeholder="you@company.com"
            class="input input-sm"
            onkeydown={(e) => e.key === 'Enter' && login()}
          />
        </div>

        <div class="form-control gap-1">
          <label class="label py-0" for="password">
            <span class="label-text text-xs font-medium">Password</span>
          </label>
          <input
            id="password"
            type="password"
            bind:value={password}
            placeholder="••••••••"
            class="input input-sm"
            onkeydown={(e) => e.key === 'Enter' && login()}
          />
        </div>

        <button
          class="btn btn-primary btn-sm w-full mt-1"
          onclick={login}
          disabled={loading || !email.trim() || !password}
        >
          {#if loading}<LoaderCircle size={15} class="animate-spin" />{/if}
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </div>
    </div>

    <p class="text-center text-xs text-base-content/35 mt-6">
      Need access? Contact your administrator.
    </p>
  </div>
</div>
