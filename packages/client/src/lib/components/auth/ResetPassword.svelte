<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { useAuth } from '$stores/auth.svelte';
import { Mail, LoaderCircle, CheckCircle } from '@lucide/svelte';

const auth = useAuth();
let email = $state('');
let error = $state<string | null>(null);
let sent = $state(false);
let loading = $state(false);

async function handleSubmit(e: Event) {
  e.preventDefault();
  error = null;
  loading = true;
  try {
    // better-auth answers a failure in `result.error` rather than throwing, so
    // the previous `await` + `sent = true` reported "check your email" for a
    // request the server had refused.
    const result = await auth.resetPassword(email);
    if (result?.error) {
      error = result.error.message || 'Failed to send reset email';
      return;
    }
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
    <p>{m['auth.check_email']()}</p>
  </div>
{:else}
  <form onsubmit={handleSubmit} class="space-y-4">
    {#if error}
      <div class="alert alert-error text-sm"><span>{error}</span></div>
    {/if}

    <label class="input input-bordered flex items-center gap-2">
      <Mail size={16} class="opacity-50" />
      <input type="email" placeholder={m['auth.email']()} bind:value={email} class="grow" required />
    </label>

    <button type="submit" disabled={loading || !email} class="btn btn-primary w-full">
      {#if loading}<LoaderCircle size={18} class="animate-spin" />{/if}
      {m['auth.reset_password']()}
    </button>
  </form>
{/if}
