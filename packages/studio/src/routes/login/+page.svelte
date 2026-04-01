<script lang="ts">
 import { goto } from '$app/navigation';
 import { base } from '$app/paths';
 import { auth } from '$lib/auth.svelte.js';

 let email = $state('');
 let password = $state('');
 let error = $state('');
 let loading = $state(false);

 async function login() {
  error = '';
  loading = true;
  try {
   await auth.signIn(email, password);
   goto(`${base}/`);
  } catch (err) {
   error = err instanceof Error ? err.message : 'Sign in failed';
  } finally {
   loading = false;
  }
 }
</script>

<div class="min-h-screen flex items-center justify-center bg-base-200 p-4">
 <div class="w-full max-w-sm">
  <!-- Logo centered -->
  <div class="text-center mb-8">
   <div class="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
        style="background: linear-gradient(135deg, #6366f1, #8b5cf6)">
    <span class="text-white font-bold text-xl">Z</span>
   </div>
   <h1 class="text-2xl font-semibold">Zveltio Studio</h1>
   <p class="text-base-content/50 text-sm mt-1">Sign in to your account</p>
  </div>

  <!-- Card -->
  <div class="card bg-base-100 shadow-lg">
   <div class="card-body gap-4">
    <div class="form-control">
     <label class="label py-1" for="login-email"><span class="label-text text-sm">Email</span></label>
     <input id="login-email" type="email" class="input" placeholder="admin@example.com" bind:value={email} />
    </div>
    <div class="form-control">
     <label class="label py-1" for="login-password">
      <span class="label-text text-sm">Password</span>
     </label>
     <input id="login-password" type="password" class="input" bind:value={password}
            onkeydown={(e) => e.key === 'Enter' && login()} />
    </div>
    {#if error}
     <div class="alert alert-error py-2 text-sm">{error}</div>
    {/if}
    <button class="btn btn-primary w-full" onclick={login} disabled={loading}>
     {#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
     Sign In
    </button>
   </div>
  </div>
 </div>
</div>
