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
  let confirmState = $state<ExtensionConfirmState>(emptyState());

  function askConfirm(
    message: string,
    action: () => void | Promise<void>,
    opts?: { title?: string; confirmLabel?: string; confirmClass?: string },
  ) {
    const isDelete = /delete|remove|discard|revoke|cancel/i.test(message);
    confirmState = {
      open: true,
      title: opts?.title ?? (isDelete ? m['common.delete']() : m['common.confirm']()),
      message,
      confirmLabel: opts?.confirmLabel ?? (isDelete ? m['common.delete']() : m['common.confirm']()),
      confirmClass: opts?.confirmClass ?? (isDelete ? 'btn-error' : 'btn-primary'),
      action,
    };
  }

  async function runConfirmAction() {
    const fn = confirmState.action;
    confirmState = emptyState();
    if (fn) await fn();
  }

  function cancelConfirm() {
    confirmState = emptyState();
  }

  return { confirmState, askConfirm, runConfirmAction, cancelConfirm };
}
