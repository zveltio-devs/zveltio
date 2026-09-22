import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/i18n.svelte.js', () => ({
  m: { 'common.delete': () => 'Delete', 'common.confirm': () => 'Confirm' },
}));

import { createExtensionConfirm } from './extension-confirm.svelte.js';

/**
 * `ConfirmModal` on every SDUI page reads `confirmState.open`, destructured
 * from this factory. The factory used to REASSIGN its `$state` variable, so
 * the object the caller holds was the first `emptyState()` forever: every
 * confirm on `SchemaPage` and `DetailLayout` — 56 extensions' delete buttons —
 * opened nothing and ran nothing. The compiler said so at build time
 * ("This reference only captures the initial value of `confirmState`") and the
 * warning was not an error.
 */
describe('createExtensionConfirm', () => {
  it('opens the state the caller destructured', () => {
    const { confirmState, askConfirm } = createExtensionConfirm();
    askConfirm('Delete this record?', () => {});
    expect(confirmState.open).toBe(true);
    expect(confirmState.message).toBe('Delete this record?');
    // Delete-ish wording picks the destructive labels.
    expect(confirmState.confirmClass).toBe('btn-error');
  });

  it('runs the action and closes on the same object', async () => {
    const { confirmState, askConfirm, runConfirmAction } = createExtensionConfirm();
    const action = vi.fn();
    askConfirm('Remove widget?', action);
    await runConfirmAction();
    expect(action).toHaveBeenCalledOnce();
    expect(confirmState.open).toBe(false);
    expect(confirmState.action).toBeNull();
  });

  it('cancel closes without running', () => {
    const { confirmState, askConfirm, cancelConfirm } = createExtensionConfirm();
    const action = vi.fn();
    askConfirm('Discard draft?', action);
    cancelConfirm();
    expect(confirmState.open).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('non-destructive wording keeps the primary button', () => {
    const { confirmState, askConfirm } = createExtensionConfirm();
    askConfirm('Publish now?', () => {});
    expect(confirmState.confirmClass).toBe('btn-primary');
  });
});
