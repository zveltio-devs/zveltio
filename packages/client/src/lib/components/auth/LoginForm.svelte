<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { Mail, Lock, LoaderCircle } from '@lucide/svelte';

  const auth = useAuth();
  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function handleSubmit() {
    error = null;
    loading = true;
    try {
      const result = await auth.signIn(email, password);
      if (result.error) {
        error = result.error.message || 'Invalid credentials';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sign in failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-4">
  {#if error}
    <div class="alert alert-error text-sm">
      <span>{error}</span>
    </div>
  {/if}

  <label class="input input-bordered flex items-center gap-2">
    <Mail size={16} class="opacity-50" />
    <input type="email" placeholder="Email" bind:value={email} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Lock size={16} class="opacity-50" />
    <input type="password" placeholder="Password" bind:value={password} class="grow" required />
  </label>

  <button
    onclick={handleSubmit}
    disabled={loading || !email || !password}
    class="btn btn-primary w-full"
  >
    {#if loading}
      <LoaderCircle size={18} class="animate-spin" />
    {/if}
    Sign In
  </button>
</div>
