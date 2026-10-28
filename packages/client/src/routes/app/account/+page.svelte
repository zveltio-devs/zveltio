<script lang="ts">
import type { MemberApiKey } from '@zveltio/sdk';
import { authClient } from '#lib/auth-client.js';
import { StepUpCancelled, StepUpEnrollmentRequired } from '#lib/step-up.svelte.js';
import { client } from '#lib/zveltio.js';
import { invalidateAll } from '$app/navigation';
import type { PageData } from './$types';

/**
 * The user's own account: profile, sessions and API keys. The keys are the
 * member's own (`/api/me/api-keys`, ADR 0010): each names the collections and
 * actions it may use, never more than the member holds, and issuing one needs
 * a step-up (the dialog in the workspace layout).
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

const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
const DAY_MS = 86_400_000;
// The local calendar day: `expires_at` is the end of the chosen day in local time,
// so the bounds and the default must be local days too, not UTC ones.
const isoDay = (ms: number) =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

let keys = $state<MemberApiKey[]>([]);
let keyName = $state('');
let keyExpires = $state(isoDay(Date.now() + 90 * DAY_MS));
/** Per collection, the actions the new key may use; a collection with none is left out. */
let keyActions = $state<Record<string, string[]>>({});
let issued = $state<string | null>(null);
let issuing = $state(false);

async function loadKeys() {
  try {
    keys = (await client.auth.apiKeys.list()).api_keys;
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
}
$effect(() => {
  loadKeys();
});

async function issueKey(e: SubmitEvent) {
  e.preventDefault();
  problem = null;
  issued = null;
  const scopes = Object.entries(keyActions)
    .filter(([, actions]) => actions.length > 0)
    .map(([collection, actions]) => ({ collection, actions }));
  if (scopes.length === 0) {
    problem = 'Choose at least one action on one collection';
    return;
  }
  issuing = true;
  try {
    const key = await client.auth.apiKeys.create({
      name: keyName,
      scopes,
      // The end of the chosen day, so a key chosen for today is not already expired.
      expires_at: new Date(`${keyExpires}T23:59:59`).toISOString(),
    });
    issued = key.key;
    keyName = '';
    keyActions = {};
    await loadKeys();
  } catch (err) {
    if (err instanceof StepUpCancelled) return;
    problem =
      err instanceof StepUpEnrollmentRequired
        ? 'Issuing a key needs a passkey or an authenticator app on your account'
        : err instanceof Error
          ? err.message
          : String(err);
  } finally {
    issuing = false;
  }
}

async function revokeKey(id: string) {
  problem = null;
  try {
    await client.auth.apiKeys.revoke(id);
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  await loadKeys();
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

  <div class="card bg-base-100 shadow">
    <div class="card-body gap-3">
      <h2 class="card-title">API keys</h2>
      <p class="text-sm text-base-content/70">
        A key lets a script act as you, on the collections and actions you choose, never beyond your own access.
      </p>
      {#if issued}
        <div role="status" class="alert alert-success flex-col items-start">
          <span>Copy the key now; it is not shown again.</span>
          <code class="break-all select-all">{issued}</code>
        </div>
      {/if}
      <ul class="divide-y divide-base-300">
        {#each keys as k (k.id)}
          <li class="py-2 flex items-center gap-3">
            <div class="flex-1 text-sm">
              <div>{k.name} <span class="text-base-content/60 font-mono">{k.key_prefix}…</span></div>
              <div class="text-base-content/60 text-xs">
                {k.scopes.map((s) => `${s.collection}: ${s.actions.join(', ')}`).join(' · ')}
                {#if k.expires_at}· expires {new Date(k.expires_at).toLocaleDateString()}{/if}
              </div>
            </div>
            {#if k.is_active}
              <button class="btn btn-ghost btn-xs text-error" onclick={() => revokeKey(k.id)}>Revoke</button>
            {:else}
              <span class="badge badge-ghost">Inactive</span>
            {/if}
          </li>
        {:else}
          <li class="py-2 text-sm text-base-content/60">No keys yet.</li>
        {/each}
      </ul>

      <form onsubmit={issueKey} class="space-y-3 border-t border-base-300 pt-3">
        <h3 class="font-semibold">New key</h3>
        <label class="floating-label">
          <span>Name</span>
          <input class="input w-full" bind:value={keyName} required maxlength="200" />
        </label>
        <label class="floating-label">
          <span>Expires</span>
          <input
            class="input w-full"
            type="date"
            bind:value={keyExpires}
            required
            min={isoDay(Date.now())}
            max={isoDay(Date.now() + 364 * DAY_MS)}
          />
        </label>
        <table class="table table-sm">
          <thead>
            <tr><th>Collection</th>{#each ACTIONS as a}<th>{a}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each data.collections as c (c.name)}
              <tr>
                <td>{c.display_name ?? c.name}</td>
                {#each ACTIONS as a}
                  <td>
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      aria-label={`${a} ${c.display_name ?? c.name}`}
                      checked={keyActions[c.name]?.includes(a) ?? false}
                      onchange={(e) => {
                        const on = e.currentTarget.checked;
                        const now = (keyActions[c.name] ?? []).filter((x) => x !== a);
                        keyActions[c.name] = on ? [...now, a] : now;
                      }}
                    />
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="flex justify-end">
          <button class="btn btn-primary" disabled={issuing}>Issue key</button>
        </div>
      </form>
    </div>
  </div>
</div>
