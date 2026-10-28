<!--
  The step-up dialog (step-up.svelte.ts). Mounted once in the host's layout;
  opens whenever a page asks `stepUp.token(action)`. The passkey ceremony starts
  from the button here, so the browser sees it as the person's own gesture.
  The kit has no catalogue: the host passes the words.
-->
<script lang="ts">
import Dialog from './Dialog.svelte';
import type { StepUp, StepUpLabels } from './step-up.svelte.js';

let { stepUp, labels }: { stepUp: StepUp; labels: StepUpLabels } = $props();

let code = $state('');
let error = $state('');
let busy = $state(false);

const p = $derived(stepUp.pending);

async function confirm() {
  error = '';
  busy = true;
  try {
    await stepUp.confirm(p?.totp ? code.trim() || undefined : undefined);
    code = '';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A cancelled browser ceremony is the person backing out, not a failure.
    if (!/NotAllowedError|AbortError/.test(msg)) error = msg;
  } finally {
    busy = false;
  }
}

function cancel() {
  code = '';
  error = '';
  stepUp.cancel();
}
</script>

<Dialog open={!!p} title={labels.title} size="sm" closeLabel={labels.close} onClose={cancel} onSubmit={confirm}>
  <p class="text-sm text-base-content/70">{labels.intro}</p>
  {#if p?.totp}
    <label class="form-control mt-4">
      <span class="label-text mb-1">
        {p.method === 'totp' ? labels.codeLabel : labels.orCodeLabel}
      </span>
      <input
        class="input input-bordered w-full tracking-widest"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{6}"
        maxlength="6"
        required={p.method === 'totp'}
        bind:value={code}
      />
    </label>
  {/if}
  {#if error}
    <div class="alert alert-error mt-4 text-sm"><span>{error}</span></div>
  {/if}
  <div class="modal-action">
    <button type="button" class="btn btn-ghost btn-sm" onclick={cancel}>{labels.cancel}</button>
    <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
      {p?.method === 'totp' || code.trim() ? labels.verifyCode : labels.usePasskey}
    </button>
  </div>
</Dialog>
