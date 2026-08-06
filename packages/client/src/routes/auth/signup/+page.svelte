<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import SignupForm from '$components/auth/SignupForm.svelte';
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
  <div class="card w-full max-w-sm bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl justify-center mb-2">{m['auth.sign_up']()}</h2>
      <SignupForm />
      <div class="divider text-sm">OR</div>
      <a href="/auth/login" class="btn btn-ghost btn-sm">{m['auth.have_account']()}</a>
    </div>
  </div>
</div>
