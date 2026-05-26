<!--
  Passkeys section — list, register, delete WebAuthn credentials
  for the signed-in user.

  Talks to the engine's @better-auth/passkey plugin via the standard
  /api/auth/passkey/* endpoints. Uses @simplewebauthn/browser to handle
  the WebAuthn ceremony — startRegistration() / startAuthentication()
  encode the challenge/response correctly for what better-auth's server
  expects.

  Component is dropped into /admin/account but designed to be reusable.
  No props for now; the signed-in user is taken from auth.user.
-->
<script lang="ts">
import { onMount } from 'svelte';
import { Fingerprint, Plus, Trash2, RefreshCw } from '@lucide/svelte';
import { auth } from '$lib/auth.svelte.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { startRegistration } from '@simplewebauthn/browser';

interface Passkey {
  id: string;
  name: string | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
}

let passkeys = $state<Passkey[]>([]);
let loading = $state(true);
let registering = $state(false);
let deletingId = $state<string | null>(null);

onMount(load);

async function load(): Promise<void> {
  loading = true;
  try {
    const res = await fetch('/api/auth/passkey/list-user-passkeys', {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { passkeys?: Passkey[] };
    passkeys = body.passkeys ?? [];
  } catch (e) {
    // 404 = endpoint not present (older engine) → silently empty.
    // anything else = log + show empty so the page still renders.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('404')) console.warn('[passkeys] load failed:', msg);
    passkeys = [];
  } finally {
    loading = false;
  }
}

async function registerNew(): Promise<void> {
  if (!browserSupportsPasskey()) {
    toast.error('This browser does not support passkeys');
    return;
  }
  const label = prompt('Name this passkey (e.g. "MacBook Touch ID", "YubiKey 5")');
  if (label == null) return; // user cancelled

  registering = true;
  try {
    // 1. Ask the server for a challenge.
    const optsRes = await fetch('/api/auth/passkey/generate-register-options', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: label.trim() || 'Unnamed passkey' }),
    });
    if (!optsRes.ok) throw new Error(`Failed to get registration options: HTTP ${optsRes.status}`);
    const options = await optsRes.json();

    // 2. Drive the browser ceremony.
    const attestation = await startRegistration({ optionsJSON: options });

    // 3. Send the attestation back for verification + storage.
    const verifyRes = await fetch('/api/auth/passkey/verify-registration', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: attestation,
        name: label.trim() || 'Unnamed passkey',
      }),
    });
    if (!verifyRes.ok) {
      const body = (await verifyRes.json().catch(() => null)) as any;
      throw new Error(body?.message ?? `Verification failed: HTTP ${verifyRes.status}`);
    }
    toast.success('Passkey registered');
    await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // User-cancelled ceremonies throw NotAllowedError / AbortError — not real errors.
    if (
      msg.includes('NotAllowedError') ||
      msg.includes('AbortError') ||
      msg.includes('cancelled')
    ) {
      // Quiet — user backed out.
      return;
    }
    toast.error(`Failed to register passkey: ${msg}`);
  } finally {
    registering = false;
  }
}

async function deleteOne(id: string): Promise<void> {
  if (!confirm('Delete this passkey? You will not be able to sign in with it anymore.')) return;
  deletingId = id;
  try {
    const res = await fetch('/api/auth/passkey/delete-passkey', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast.success('Passkey deleted');
    await load();
  } catch (e) {
    toast.error(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    deletingId = null;
  }
}

function browserSupportsPasskey(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator.credentials?.create === 'function'
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}
</script>

<section class="card bg-base-200">
  <div class="card-body">
    <div class="flex items-start justify-between gap-4">
      <div class="flex items-start gap-3">
        <div class="p-2 bg-primary/10 rounded-lg shrink-0">
          <Fingerprint size={20} class="text-primary" />
        </div>
        <div>
          <h2 class="card-title text-base">Passkeys</h2>
          <p class="text-sm text-base-content/60 mt-0.5">
            Sign in without a password using your device's biometric authenticator
            (Touch ID, Windows Hello, security key).
          </p>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="btn btn-ghost btn-sm"
          onclick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh passkeys list"
        >
          <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
        </button>
        <button
          class="btn btn-primary btn-sm gap-1.5"
          onclick={registerNew}
          disabled={registering || !browserSupportsPasskey()}
        >
          <Plus size={14} />
          {registering ? 'Registering…' : 'Add passkey'}
        </button>
      </div>
    </div>

    {#if !browserSupportsPasskey()}
      <div class="alert alert-warning mt-4 text-sm">
        <span>This browser does not support passkeys. Use a recent version of Chrome, Edge, Safari, or Firefox.</span>
      </div>
    {/if}

    <div class="mt-4">
      {#if loading}
        <div class="text-sm text-base-content/40 py-6 text-center">Loading passkeys…</div>
      {:else if passkeys.length === 0}
        <div class="text-sm text-base-content/40 py-6 text-center">
          No passkeys yet. Click <strong>Add passkey</strong> to register your first one.
        </div>
      {:else}
        <ul class="divide-y divide-base-300">
          {#each passkeys as pk (pk.id)}
            <li class="py-2.5 flex items-center gap-3">
              <Fingerprint size={16} class="text-base-content/40 shrink-0" />
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium truncate">{pk.name ?? 'Unnamed passkey'}</p>
                <p class="text-xs text-base-content/50 mt-0.5">
                  Added {formatDate(pk.createdAt)}
                  {#if pk.deviceType}· {pk.deviceType}{/if}
                  {#if pk.backedUp}· Synced{/if}
                </p>
              </div>
              <button
                class="btn btn-ghost btn-xs text-error"
                onclick={() => deleteOne(pk.id)}
                disabled={deletingId === pk.id}
                aria-label="Delete passkey"
              >
                <Trash2 size={13} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</section>
