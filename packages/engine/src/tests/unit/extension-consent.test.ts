/**
 * Capability consent — the manifest asks, an administrator decides.
 *
 * Without this, the capability contract is only as strong as the extension's
 * own manifest on the one path that matters: ship v1 declaring nothing, ship v2
 * declaring `db:admin`, and an update hands it cross-tenant database access
 * because it said so. The test named after that scenario is the point of the
 * whole module.
 */

import { describe, expect, it } from 'bun:test';
import { CapabilityDeniedError, gateInternals } from '../../lib/extensions/capabilities.js';
import { parseGranted, resolveCapabilities } from '../../lib/extensions/consent.js';

describe('the update-widening scenario', () => {
  it('does not grant a capability a new version added on its own say-so', () => {
    // v1 shipped and was installed asking for nothing.
    const granted = resolveCapabilities([], []).effective;
    expect(granted).toEqual([]);

    // v2 ships asking for cross-tenant database access.
    const r = resolveCapabilities(['db:admin'], granted);
    expect(r.effective).toEqual([]);
    expect(r.pending).toEqual(['db:admin']);
  });

  it('grants it once an administrator approves', () => {
    const r = resolveCapabilities(['db:admin'], ['db:admin']);
    expect(r.effective).toEqual(['db:admin']);
    expect(r.pending).toEqual([]);
  });

  it('keeps the capabilities that were already approved', () => {
    // A widening request must not cost the extension what it already had —
    // otherwise every update is an outage for unrelated features.
    const r = resolveCapabilities(['secrets', 'files', 'db:admin'], ['secrets', 'files']);
    expect(r.effective).toEqual(['secrets', 'files']);
    expect(r.pending).toEqual(['db:admin']);
  });
});

describe('consent does not accumulate', () => {
  it('drops a capability the extension stopped asking for', () => {
    const r = resolveCapabilities(['secrets'], ['secrets', 'db:admin']);
    expect(r.effective).toEqual(['secrets']);
    expect(r.dropped).toEqual(['db:admin']);
  });

  it('never grants something that was approved but is not declared', () => {
    // The intersection runs both ways: a stale grant is not authority.
    const r = resolveCapabilities([], ['db:admin', 'secrets']);
    expect(r.effective).toEqual([]);
  });
});

describe('installs predating consent tracking', () => {
  it('is grandfathered to its declared set rather than crippled', () => {
    // null = the column did not exist when this was installed. Nobody was ever
    // asked, so treating silence as refusal would break working installs on an
    // engine upgrade — a security posture that ships as an outage gets reverted.
    const r = resolveCapabilities(['secrets', 'db:admin'], null);
    expect(r.effective).toEqual(['secrets', 'db:admin']);
    expect(r.pending).toEqual([]);
    expect(r.grandfathered).toBe(true);
  });

  it('is distinguishable from an explicit grant of nothing', () => {
    const explicit = resolveCapabilities(['secrets'], []);
    expect(explicit.grandfathered).toBe(false);
    expect(explicit.effective).toEqual([]);
    expect(explicit.pending).toEqual(['secrets']);
  });
});

describe('parseGranted', () => {
  it('reads an array, and the string form some drivers return', () => {
    expect(parseGranted(['secrets'])).toEqual(['secrets']);
    expect(parseGranted('["secrets","files"]')).toEqual(['secrets', 'files']);
  });

  it('returns null for absent consent, not an empty grant', () => {
    // The difference decides whether an install is grandfathered or refused.
    expect(parseGranted(null)).toBeNull();
    expect(parseGranted(undefined)).toBeNull();
  });

  it('treats malformed JSON as absent rather than throwing at load', () => {
    expect(parseGranted('{not json')).toBeNull();
    expect(parseGranted(42)).toBeNull();
  });

  it('drops non-string members instead of trusting them', () => {
    expect(parseGranted(['secrets', 7, null, 'files'])).toEqual(['secrets', 'files']);
  });
});

describe('the denial tells the operator where to go', () => {
  const internals = { decryptSecret: () => 'plaintext' };

  it('says "approve it" when the manifest declares but nobody approved', () => {
    const g = gateInternals('ai', internals, [], ['secrets']);
    try {
      g.decryptSecret();
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect((e as CapabilityDeniedError).awaitingApproval).toBe(true);
      expect(msg).toContain('approve-capabilities');
      expect(msg).not.toContain('Add it to "permissions"');
    }
  });

  it('says "declare it" when the manifest does not ask at all', () => {
    // Telling an operator to edit manifest.json when the entry is already
    // there sends them to the wrong place entirely.
    const g = gateInternals('ai', internals, [], []);
    try {
      g.decryptSecret();
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect((e as CapabilityDeniedError).awaitingApproval).toBe(false);
      expect(msg).toContain('Add it to "permissions"');
      expect(msg).not.toContain('approve-capabilities');
    }
  });

  it('still denies — a pending capability is described, not granted', () => {
    const g = gateInternals('ai', internals, [], ['secrets']);
    expect(() => g.decryptSecret()).toThrow(CapabilityDeniedError);
  });
});
