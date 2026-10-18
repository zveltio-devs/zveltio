<!--
  The step-up dialog (lib/step-up.svelte.ts). Mounted once in the admin layout;
  opens whenever a page asks `stepUp.token(action)`. The passkey ceremony starts
  from the button here, so the browser sees it as the person's own gesture.
-->
<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { stepUp } from '$lib/step-up.svelte.js';
import Modal from './Modal.svelte';

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

<Modal open={!!p} title={m['stepUp.title']()} size="sm" onClose={cancel} onSubmit={confirm}>
  <p class="text-sm text-base-content/70">{m['stepUp.intro']()}</p>
  {#if p?.totp}
    <label class="form-control mt-4">
      <span class="label-text mb-1">
        {p.method === 'totp' ? m['stepUp.codeLabel']() : m['stepUp.orCodeLabel']()}
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
    <button type="button" class="btn btn-ghost btn-sm" onclick={cancel}>{m['common.cancel']()}</button>
    <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
      {p?.method === 'totp' || code.trim() ? m['stepUp.verifyCode']() : m['stepUp.usePasskey']()}
    </button>
  </div>
</Modal>
