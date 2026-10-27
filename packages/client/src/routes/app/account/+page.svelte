<script lang="ts">
import { authClient } from '#lib/auth-client.js';
import { invalidateAll } from '$app/navigation';
import type { PageData } from './$types';

/**
 * The user's own account: profile and sessions. API keys are not here: the
 * engine issues them to instance administrators only (`/api/api-keys`), so the
 * Console is where they live.
 */
let { data }: { data: PageData } = $props();

let name = $state('');
$effect(() => {
  name = data.user.name ?? '';
});
let saved = $state(false);
let problem = $state<string | null>(null);

type Session = NonNullable<Awaited<ReturnType<typeof authClient.listSessions>>['data']>[number];
let sessions = $state<Session[]>([]);
const current = authClient.useSession();

async function loadSessions() {
  try {
    const res = await authClient.listSessions();
    sessions = res.data ?? [];
    if (res.error) problem = res.error.message ?? 'Could not list the sessions';
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
}
$effect(() => {
  loadSessions();
});

async function saveProfile(e: SubmitEvent) {
  e.preventDefault();
  problem = null;
  saved = false;
  const res = await fetch(`${data.engineUrl}/api/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    problem = json?.detail ?? json?.error ?? `HTTP ${res.status}`;
    return;
  }
  saved = true;
  await invalidateAll();
}

async function revoke(token: string) {
  problem = null;
  const res = await authClient.revokeSession({ token });
  if (res.error) problem = res.error.message ?? 'Could not revoke the session';
  await loadSessions();
}
</script>

<svelte:head><title>Account</title></svelte:head>

<div class="max-w-2xl space-y-6">
  <h1 class="text-2xl font-bold">Account</h1>
  {#if problem}<div role="alert" class="alert alert-error">{problem}</div>{/if}

  <form onsubmit={saveProfile} class="card bg-base-100 shadow">
    <div class="card-body gap-3">
      <h2 class="card-title">Profile</h2>
      <label class="floating-label">
        <span>Email</span>
        <input class="input w-full" value={data.user.email ?? ''} readonly />
      </label>
      <label class="floating-label">
        <span>Name</span>
        <input class="input w-full" bind:value={name} required maxlength="200" />
      </label>
      <div class="card-actions justify-end items-center">
        {#if saved}<span class="text-sm text-success">Saved</span>{/if}
        <button class="btn btn-primary">Save</button>
      </div>
    </div>
  </form>

  <div class="card bg-base-100 shadow">
    <div class="card-body">
      <h2 class="card-title">Sessions</h2>
      <ul class="divide-y divide-base-300">
        {#each sessions as s (s.id)}
          <li class="py-2 flex items-center gap-3">
            <div class="flex-1 text-sm">
              <div>{s.userAgent ?? 'Unknown device'}</div>
              <div class="text-base-content/60 text-xs">
                {s.ipAddress ?? ''} · since {new Date(s.createdAt).toLocaleString()}
              </div>
            </div>
            {#if s.id === current.get().data?.session?.id}
              <span class="badge badge-ghost">This device</span>
            {:else}
              <button class="btn btn-ghost btn-xs text-error" onclick={() => revoke(s.token)}>Sign out</button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  </div>
</div>
