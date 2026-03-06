<script lang="ts">
  import LoginForm from '$components/auth/LoginForm.svelte';
  import { page } from '$app/stores';
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card w-full max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl justify-center mb-2">Sign In</h2>

      {#if $page.url.searchParams.get('registered')}
        <div class="alert alert-success text-sm mb-2">
          Account created! Please sign in.
        </div>
      {/if}

      {#if $page.url.searchParams.get('error') === 'insufficient_role'}
        <div class="alert alert-warning text-sm mb-2">
          You don't have permission to access that page.
        </div>
      {/if}

      <LoginForm />

      <div class="divider text-sm">OR</div>
      <a href="/auth/signup" class="btn btn-ghost btn-sm">Create Account</a>
      <a href="/auth/reset-password" class="link link-primary text-sm text-center">
        Forgot password?
      </a>
    </div>
  </div>
</div>
