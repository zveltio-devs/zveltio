import { describe, expect, it } from 'bun:test';
import { ACTION_REFUSAL, ActionRefusal } from '../extension/action-refusal.js';

// extension-api v1: the engine recognises a refusal by this registered key,
// not by `instanceof` (each extension bundles its own SDK copy). Changing the
// key silently turns every v1 extension's refusal into a 500.
describe('ActionRefusal (extension-api v1)', () => {
  it('marks itself with the registered key the engine reads', () => {
    expect(ACTION_REFUSAL as symbol).toBe(Symbol.for('zveltio.extension.action-refusal'));
    const r = new ActionRefusal(409, 'already_paid', 'Invoice already paid');
    expect(r[ACTION_REFUSAL]).toBe(true);
    expect([r.status, r.code, r.message]).toEqual([409, 'already_paid', 'Invoice already paid']);
  });
});
