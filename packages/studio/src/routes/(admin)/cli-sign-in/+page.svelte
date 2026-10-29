<script lang="ts">
/**
 * A terminal asks to act as the signed-in user: sign the CLI in, or confirm one
 * change it is about to make (engine lib/cli-sign-in.ts, ADR 0011 amendment 1).
 * Approving steps up for `cli.approve:<code>`; `api` opens the dialog itself.
 */
import { api } from '#lib/api.js';
import { m } from '#lib/i18n.svelte.js';
import { page } from '$app/state';
import { onMount } from 'svelte';
import PageHeader from '#lib/components/common/PageHeader.svelte';
import { stepUpAborted } from '#lib/step-up.svelte.js';
import { Terminal, ShieldCheck, X } from '@lucide/svelte';

interface CliRequest {
  code: string;
  kind: 'login' | 'step-up';
  action: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  for_this_account: boolean;
}

let code = $state(page.url.searchParams.get('code') ?? '');
let request = $state<CliRequest | null>(null);
let error = $state('');
let outcome = $state<'approved' | 'denied' | null>(null);
let busy = $state(false);

async function lookup(): Promise<void> {
  error = '';
  request = null;
  outcome = null;
  if (!code.trim()) return;
  try {
    request = await api.get<CliRequest>(
      `/api/auth/cli/request?code=${encodeURIComponent(code.trim())}`,
    );
  } catch (e) {
    error = (e as { status?: number }).status === 404 ? m['cli.notFound']() : (e as Error).message;
  }
}

async function decide(verb: 'approve' | 'deny'): Promise<void> {
  if (!request) return;
  busy = true;
  try {
    await api.post(`/api/auth/cli/${verb}`, { code: request.code });
    outcome = verb === 'approve' ? 'approved' : 'denied';
  } catch (e) {
    if (!stepUpAborted(e)) error = (e as Error).message;
  } finally {
    busy = false;
  }
}

// Once, from the link the terminal opened: an effect would re-run on every keystroke.
onMount(() => {
  if (code) void lookup();
});
</script>

<PageHeader title={m['cli.title']()} subtitle={m['cli.subtitle']()} />

<div class="max-w-xl space-y-4">
  <form
    class="flex gap-2"
    onsubmit={(e) => {
      e.preventDefault();
      void lookup();
    }}
  >
    <label class="input input-bordered flex-1 flex items-center gap-2">
      <Terminal size={16} class="opacity-50" />
      <span class="sr-only">{m['cli.codeLabel']()}</span>
      <input
        class="grow font-mono uppercase tracking-widest"
        placeholder="BCDF-GHJK"
        aria-label={m['cli.codeLabel']()}
        bind:value={code}
      />
    </label>
    <button class="btn" type="submit">{m['cli.lookup']()}</button>
  </form>

  {#if error}
    <div class="alert alert-error text-sm" role="alert">{error}</div>
  {/if}

  {#if outcome === 'approved'}
    <div class="alert alert-success text-sm" role="status">{m['cli.approved']()}</div>
  {:else if outcome === 'denied'}
    <div class="alert alert-info text-sm" role="status">{m['cli.denied']()}</div>
  {:else if request}
    <div class="card bg-base-100 border border-base-300">
      <div class="card-body gap-3">
        <p class="font-mono text-2xl tracking-widest text-center">{request.code}</p>
        <p class="font-semibold">
          {request.kind === 'login'
            ? m['cli.kindLogin']()
            : m['cli.kindStepUp']({ action: request.action ?? '' })}
        </p>
        <p class="text-sm opacity-70">
          {m['cli.from']({ ip: request.ip ?? '?', agent: request.user_agent ?? '?' })}
          · {new Date(request.created_at).toLocaleString()}
        </p>
        {#if request.for_this_account}
          <div class="alert alert-warning text-sm">{m['cli.compare']()}</div>
          <div class="flex gap-2">
            <button class="btn btn-primary flex-1 gap-1" disabled={busy} onclick={() => decide('approve')}>
              <ShieldCheck size={16} /> {m['cli.approve']()}
            </button>
            <button class="btn btn-ghost gap-1" disabled={busy} onclick={() => decide('deny')}>
              <X size={16} /> {m['cli.deny']()}
            </button>
          </div>
        {:else}
          <div class="alert alert-error text-sm">{m['cli.notForYou']()}</div>
        {/if}
      </div>
    </div>
  {/if}
</div>
