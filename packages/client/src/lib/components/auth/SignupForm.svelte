<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { Mail, Lock, User, LoaderCircle } from '@lucide/svelte';

  const auth = useAuth();
  let name = $state('');
  let email = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function handleSubmit() {
    error = null;

    if (password !== confirmPassword) {
      error = 'Passwords do not match';
      return;
    }

    if (password.length < 8) {
      error = 'Password must be at least 8 characters';
      return;
    }

    loading = true;
    try {
      const result = await auth.signUp({ email, password, name });
      if (result.error) {
        error = result.error.message || 'Sign up failed';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sign up failed';
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
    <User size={16} class="opacity-50" />
    <input type="text" placeholder="Full name" bind:value={name} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Mail size={16} class="opacity-50" />
    <input type="email" placeholder="Email" bind:value={email} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Lock size={16} class="opacity-50" />
    <input type="password" placeholder="Password" bind:value={password} class="grow" required />
  </label>

  <label class="input input-bordered flex items-center gap-2">
    <Lock size={16} class="opacity-50" />
    <input type="password" placeholder="Confirm password" bind:value={confirmPassword} class="grow" required />
  </label>

  <button
    onclick={handleSubmit}
    disabled={loading || !email || !password || !name}
    class="btn btn-primary w-full"
  >
    {#if loading}
      <LoaderCircle size={18} class="animate-spin" />
    {/if}
    Create Account
  </button>
</div>
