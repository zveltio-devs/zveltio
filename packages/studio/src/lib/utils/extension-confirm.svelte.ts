import { m } from '$lib/i18n.svelte.js';

export type ExtensionConfirmState = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass: string;
  action: (() => void | Promise<void>) | null;
};

const emptyState = (): ExtensionConfirmState => ({
  open: false,
  title: '',
  message: '',
  confirmLabel: '',
  confirmClass: 'btn-error',
  action: null,
});

export function createExtensionConfirm() {
  // MUTATED, never reassigned. Callers destructure this object
  // (`const { confirmState } = createExtensionConfirm()`), so a reassignment
  // here rebinds only the local variable and leaves every consumer holding the
  // first `emptyState()`: `ConfirmModal` on SchemaPage and DetailLayout read
  // `open: false` forever, so no extension page's confirm ever opened and no
  // confirmed action ever ran. The Svelte compiler warned about exactly this
  // ("This reference only captures the initial value of `confirmState`") and a
  // warning is not a build failure.
  const confirmState = $state<ExtensionConfirmState>(emptyState());

  function reset(): void {
    Object.assign(confirmState, emptyState());
  }

  function askConfirm(
    message: string,
    action: () => void | Promise<void>,
    opts?: { title?: string; confirmLabel?: string; confirmClass?: string },
  ) {
    const isDelete = /delete|remove|discard|revoke|cancel/i.test(message);
    Object.assign(confirmState, {
      open: true,
      title: opts?.title ?? (isDelete ? m['common.delete']() : m['common.confirm']()),
      message,
      confirmLabel: opts?.confirmLabel ?? (isDelete ? m['common.delete']() : m['common.confirm']()),
      confirmClass: opts?.confirmClass ?? (isDelete ? 'btn-error' : 'btn-primary'),
      action,
    });
  }

  async function runConfirmAction() {
    const fn = confirmState.action;
    reset();
    if (fn) await fn();
  }

  function cancelConfirm() {
    reset();
  }

  return { confirmState, askConfirm, runConfirmAction, cancelConfirm };
}
