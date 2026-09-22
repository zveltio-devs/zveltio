import { beforeEach, describe, expect, it } from 'vitest';

import { _resetForTests, installGlobalApi, studioApi } from './extension-api.svelte.js';

/**
 * The compile-time path (`registerContributionSlot`) replaces a prior entry from
 * the same owner. The `window.__zveltio.registerSlot` path pushed
 * unconditionally, so a page whose `<script>` ran twice — HMR, a remount, a
 * navigation back to the same route — stacked the same widget again, and the
 * slot rendered it once per registration.
 */
type SlotFn = (name: string, contribution: { component: unknown; priority?: number }) => void;
type Installed = {
  registerSlot: SlotFn;
  registerFormAlter: (id: string, hook: () => void) => void;
};

/** The global the IIFE path installs. Typed here rather than on `Window`. */
function zveltio(): Installed {
  return (window as unknown as { __zveltio: Installed }).__zveltio;
}

const component = (() => {}) as unknown as never;

beforeEach(() => {
  _resetForTests();
  installGlobalApi('http://engine.test');
});

describe('window.__zveltio.registerSlot', () => {
  it('does not stack the same component twice on one slot', () => {
    const zv = zveltio();
    zv.registerSlot('dashboard.cards', { component, priority: 10 });
    zv.registerSlot('dashboard.cards', { component, priority: 10 });

    expect(studioApi.getSlotContributions('dashboard.cards')).toHaveLength(1);
  });

  it('a re-registration takes the newer priority', () => {
    const zv = zveltio();
    zv.registerSlot('dashboard.cards', { component, priority: 10 });
    zv.registerSlot('dashboard.cards', { component, priority: 1 });

    const list = studioApi.getSlotContributions('dashboard.cards');
    expect(list).toHaveLength(1);
    expect(list[0].priority).toBe(1);
  });

  it('two different components still both register', () => {
    const other = (() => {}) as typeof component;
    const zv = zveltio();
    zv.registerSlot('dashboard.cards', { component, priority: 10 });
    zv.registerSlot('dashboard.cards', { component: other, priority: 20 });

    expect(studioApi.getSlotContributions('dashboard.cards')).toHaveLength(2);
  });
});

describe('window.__zveltio.registerFormAlter', () => {
  it('runs a hook once even if registered twice', () => {
    const zv = zveltio();
    let runs = 0;
    const hook = () => {
      runs++;
    };
    zv.registerFormAlter('core:user-edit', hook);
    zv.registerFormAlter('core:user-edit', hook);

    studioApi.applyFormAlters('core:user-edit', { fields: [] } as never);
    expect(runs, 'a hook registered twice altered the form twice').toBe(1);
  });
});
