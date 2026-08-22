/**
 * D3 — enabling an extension activates its contribution without a full reload;
 * disabling unregisters it. Uses injected module map so vitest never loads real
 * Svelte contribute.ts files.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const unregister = vi.fn();
vi.mock('$lib/extension-api.svelte.js', () => ({
  unregisterContributions: (...args: unknown[]) => unregister(...args),
  registerContributionSlot: vi.fn(),
}));

vi.mock('$lib/ext/.contributions.generated.js', () => ({
  CONTRIBUTION_MODULES: {},
}));

const {
  loadExtensionContributions,
  _resetContributionLoaderForTests,
  _activatedContributionsForTests,
} = await import('./load-extension-contributions');

beforeEach(() => {
  _resetContributionLoaderForTests();
  unregister.mockClear();
});

describe('loadExtensionContributions', () => {
  it('activates a module once when the extension becomes active', async () => {
    const activate = vi.fn();
    const modules = {
      crm: async () => ({ activate }),
    };

    await loadExtensionContributions(['crm'], modules);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(_activatedContributionsForTests().has('crm')).toBe(true);

    await loadExtensionContributions(['crm'], modules);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('unregisters when the extension leaves the active set', async () => {
    const activate = vi.fn();
    const modules = {
      crm: async () => ({ activate }),
    };

    await loadExtensionContributions(['crm'], modules);
    await loadExtensionContributions([], modules);

    expect(unregister).toHaveBeenCalledWith('crm');
    expect(_activatedContributionsForTests().has('crm')).toBe(false);
  });

  it('skips names with no contribution module', async () => {
    await loadExtensionContributions(['unknown'], {});
    expect(_activatedContributionsForTests().size).toBe(0);
  });
});
