<script lang="ts">
  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    confirmClass?: string;
    onconfirm: () => void;
    oncancel: () => void;
  }
  let {
    open, title, message,
    confirmLabel = 'Confirm',
    confirmClass = 'btn-error',
    onconfirm, oncancel,
  }: Props = $props();
</script>

{#if open}
  <div class="modal modal-open z-50">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-lg">{title}</h3>
      <p class="py-4 text-sm text-base-content/70">{message}</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={oncancel}>Cancel</button>
        <button class="btn {confirmClass} btn-sm" onclick={onconfirm}>{confirmLabel}</button>
      </div>
    </div>
    <div class="modal-backdrop bg-black/40" role="button" tabindex="0" onclick={oncancel} onkeydown={(e) => e.key === 'Enter' || e.key === ' ' ? (oncancel(), false) : null}></div>
  </div>
{/if}
