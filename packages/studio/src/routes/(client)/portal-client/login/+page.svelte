<script lang="ts">
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { auth } from '#lib/auth.svelte.js';

let email = $state('');
let password = $state('');
let loading = $state(false);
let error = $state<string | null>(null);
// Accounts with TOTP answer the password with a second step, not a session.
let secondFactor = $state(false);
let code = $state('');

async function handleLogin(e: Event) {
  e.preventDefault();
  loading = true;
  error = null;
  try {
    if (secondFactor) await auth.verifySecondFactor(code);
    else if ((await auth.signIn(email, password)).twoFactor) {
      secondFactor = true;
      return;
    }
    goto(resolve(`portal-client/`));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
        {#if secondFactor}
        <div class="form-control">
          <label class="label pb-1" for="portal-code"><span class="label-text text-sm">Authenticator or backup code</span></label>
          <input
            id="portal-code" bind:value={code} required autocomplete="one-time-code"
            class="input input-bordered input-sm w-full font-mono"
          />
        </div>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => { secondFactor = false; code = ''; error = null; }}>
          Cancel
        </button>
        {:else}
        <div class="form-control">
          <label class="label pb-1" for="portal-email"><span class="label-text text-sm">Email</span></label>
          <input
            id="portal-email" type="email" bind:value={email} required
            class="input input-bordered input-sm w-full" placeholder="you@example.com"
          />
        </div>
        <div class="form-control">
          <label class="label pb-1" for="portal-password"><span class="label-text text-sm">Password</span></label>
          <input
            id="portal-password" type="password" bind:value={password} required
            class="input input-bordered input-sm w-full" placeholder="••••••••"
          />
        </div>
        {/if}
        <button type="submit" class="btn btn-primary btn-sm w-full mt-2" disabled={loading}>
          {#if loading}<span class="loading loading-spinner loading-xs"></span>{/if}
          Sign in
        </button>
      </form>
    </div>
  </div>
</div>
