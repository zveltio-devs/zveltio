<script lang="ts">
  import { useAuth } from '$stores/auth.svelte';
  import { Mail, LoaderCircle, CheckCircle } from '@lucide/svelte';

  const auth = useAuth();
  let email = $state('');
  let error = $state<string | null>(null);
  let sent = $state(false);
  let loading = $state(false);

  async function handleSubmit() {
    error = null;
    loading = true;
    try {
      await auth.resetPassword(email);
      sent = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to send reset email';
    } finally {
      loading = false;
    }
  }
</script>

{#if sent}
  <div class="text-center space-y-3">
    <CheckCircle size={48} class="text-success mx-auto" />
    <p>Check your email for a reset link.</p>
  </div>
{:else}
  <div class="space-y-4">
    {#if error}
      <div class="alert alert-error text-sm"><span>{error}</span></div>
    {/if}

    <label class="input input-bordered flex items-center gap-2">
      <Mail size={16} class="opacity-50" />
      <input type="email" placeholder="Email" bind:value={email} class="grow" required />
    </label>

    <button onclick={handleSubmit} disabled={loading || !email} class="btn btn-primary w-full">
      {#if loading}<LoaderCircle size={18} class="animate-spin" />{/if}
      Send Reset Link
    </button>
  </div>
{/if}
