<script lang="ts">
 import { goto } from '$app/navigation';
 import { base } from '$app/paths';
 import { page } from '$app/state';
 import { onMount } from 'svelte';
 import { auth } from '$lib/auth.svelte.js';
 import { Fingerprint, AlertCircle, Sparkles } from '@lucide/svelte';
 import { startAuthentication } from '@simplewebauthn/browser';

 let email = $state('');
 let password = $state('');
 let error = $state('');
 let loading = $state(false);
 let passkeyLoading = $state(false);

 // Demo-mode credentials surface to remove the "wait, what login?" friction
 // for visitors arriving at a public demo. Engine returns these via
 // /api/health when DEMO_MODE=true. Never enabled on real installs.
 let demoCreds = $state<{ email: string; password: string } | null>(null);
 onMount(async () => {
  try {
   const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ ?? '';
   const r = await fetch(`${engineUrl}/api/health`, { credentials: 'include' });
   const j = await r.json();
   if (j?.demo_mode && j?.demo_credentials) demoCreds = j.demo_credentials;
  } catch { /* engine unreachable — show normal login */ }
 });

 function useDemoCreds() {
  if (!demoCreds) return;
  email = demoCreds.email;
  password = demoCreds.password;
 }

 // Layout redirects unauthenticated users here with ?reason= and ?redirect=
 // — surface the reason so users understand why they were bounced, and
 // preserve the deep link so we return them to it after sign-in.
 const reason = $derived(page.url.searchParams.get('reason'));
 const redirectTo = $derived(page.url.searchParams.get('redirect') ?? `${base}/`);
 const reasonMessage = $derived.by(() => {
  switch (reason) {
   case 'session_required': return 'Sign in to continue.';
   case 'session_expired':  return 'Your session expired — sign in again to continue.';
   case 'signed_out':       return 'You have been signed out.';
   default: return null;
  }
 });

 async function login() {
  error = '';
  loading = true;
  try {
   await auth.signIn(email, password);
   goto(redirectTo);
  } catch (err) {
   error = err instanceof Error ? err.message : 'Sign in failed';
  } finally {
   loading = false;
  }
 }

 function browserSupportsPasskey(): boolean {
  return typeof window !== 'undefined'
   && 'PublicKeyCredential' in window
   && typeof navigator.credentials?.get === 'function';
 }

 /**
  * Sign in with a registered passkey. Browser drives the WebAuthn
  * ceremony; we POST the assertion to better-auth's verifier endpoint
  * which sets the session cookie on success.
  */
 async function signInWithPasskey() {
  if (!browserSupportsPasskey()) {
   error = 'This browser does not support passkeys';
   return;
  }
  error = '';
  passkeyLoading = true;
  try {
   const optsRes = await fetch('/api/auth/passkey/generate-authenticate-options', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
   });
   if (!optsRes.ok) throw new Error(`Failed to start passkey sign-in: HTTP ${optsRes.status}`);
   const options = await optsRes.json();

   const assertion = await startAuthentication({ optionsJSON: options });

   const verifyRes = await fetch('/api/auth/passkey/verify-authentication', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response: assertion }),
   });
   if (!verifyRes.ok) {
    const body = await verifyRes.json().catch(() => null) as any;
    throw new Error(body?.message ?? `Sign-in failed: HTTP ${verifyRes.status}`);
   }
   await auth.init();
   goto(`${base}/`);
  } catch (err) {
   const msg = err instanceof Error ? err.message : String(err);
   // User cancellation isn't an error worth showing.
   if (!msg.includes('NotAllowedError') && !msg.includes('AbortError') && !msg.includes('cancelled')) {
    error = `Passkey sign-in failed: ${msg}`;
   }
  } finally {
   passkeyLoading = false;
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

  {#if reasonMessage}
   <div role="status" class="alert alert-info py-2 mb-4 text-sm">
    <AlertCircle size={16} />
    <span>{reasonMessage}</span>
   </div>
  {/if}

  {#if demoCreds}
   <div class="alert alert-warning py-3 mb-4 text-sm flex-col items-start gap-2">
    <div class="flex items-center gap-2 font-semibold w-full">
     <Sparkles size={14} /> Demo instance
    </div>
    <p class="text-xs opacity-90">
     This is a shared demo. Data resets periodically. Use these credentials:
    </p>
    <div class="text-xs font-mono bg-base-100 text-base-content p-2 rounded w-full">
     {demoCreds.email} / {demoCreds.password}
    </div>
    <button type="button" class="btn btn-xs btn-warning self-end" onclick={useDemoCreds}>
     Fill in
    </button>
   </div>
  {/if}

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

    {#if browserSupportsPasskey()}
     <div class="divider text-xs text-base-content/40 my-1">or</div>
     <button
      class="btn btn-outline w-full gap-2"
      onclick={signInWithPasskey}
      disabled={passkeyLoading}
     >
      {#if passkeyLoading}
       <span class="loading loading-spinner loading-sm"></span>
      {:else}
       <Fingerprint size={16} />
      {/if}
      Sign in with passkey
     </button>
    {/if}
   </div>
  </div>
 </div>
</div>
