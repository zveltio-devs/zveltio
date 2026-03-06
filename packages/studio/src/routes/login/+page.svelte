<script lang="ts">
 import { goto } from '$app/navigation';
 import { base } from '$app/paths';
 import { auth } from '$lib/auth.svelte.js';

 let email = $state('');
 let password = $state('');
 let error = $state('');
 let loading = $state(false);

 async function handleSubmit(e: SubmitEvent) {
 e.preventDefault();
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

<div class="min-h-screen flex items-center justify-center bg-base-200">
 <div class="card w-full max-w-sm bg-base-100 shadow-xl">
 <div class="card-body">
 <div class="flex items-center justify-center mb-6">
 <div class="w-12 h-12 bg-primary rounded-xl flex items-center justify-center">
 <span class="text-primary-content font-bold text-xl">Z</span>
 </div>
 </div>

 <h1 class="text-2xl font-bold text-center">Zveltio Studio</h1>
 <p class="text-center text-base-content/60 text-sm mb-4">Sign in to your admin account</p>

 {#if error}
 <div class="alert alert-error text-sm py-2">
 <span>{error}</span>
 </div>
 {/if}

 <form onsubmit={handleSubmit} class="space-y-4">
 <div class="form-control">
 <label class="label" for="email">
 <span class="label-text">Email</span>
 </label>
 <input
 id="email"
 type="email"
 bind:value={email}
 placeholder="admin@example.com"
 class="input"
 required
 />
 </div>

 <div class="form-control">
 <label class="label" for="password">
 <span class="label-text">Password</span>
 </label>
 <input
 id="password"
 type="password"
 bind:value={password}
 placeholder="••••••••"
 class="input"
 required
 />
 </div>

 <button type="submit" class="btn btn-primary w-full" disabled={loading}>
 {#if loading}
 <span class="loading loading-spinner loading-sm"></span>
 {/if}
 Sign In
 </button>
 </form>
 </div>
 </div>
</div>
