<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { auth } from '$lib/auth.svelte.js';

  let email = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function handleLogin(e: Event) {
    e.preventDefault();
    loading = true;
    error = null;
    try {
      await auth.signIn(email, password);
      goto(`${base}/portal-client/`);
    } catch (err: any) {
      error = err?.message ?? 'Login failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-base-100 px-4">
  <div class="card bg-base-200 border border-base-300 w-full max-w-sm">
    <div class="card-body gap-4">
      <h1 class="text-xl font-bold text-center">Sign in</h1>

      {#if error}
        <div class="alert alert-error text-sm py-2">{error}</div>
      {/if}

      <form onsubmit={handleLogin} class="space-y-3">
        <div class="form-control">
          <label class="label pb-1"><span class="label-text text-sm">Email</span></label>
          <input
            type="email" bind:value={email} required
            class="input input-bordered input-sm w-full" placeholder="you@example.com"
          />
        </div>
        <div class="form-control">
          <label class="label pb-1"><span class="label-text text-sm">Password</span></label>
          <input
            type="password" bind:value={password} required
            class="input input-bordered input-sm w-full" placeholder="••••••••"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-sm w-full mt-2" disabled={loading}>
          {#if loading}<span class="loading loading-spinner loading-xs"></span>{/if}
          Sign in
        </button>
      </form>
    </div>
  </div>
</div>
