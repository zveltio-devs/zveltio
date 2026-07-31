/**
 * The extension capability contract.
 *
 * The previous capability policy (`hasCapability`) was documented in the README
 * and dead in practice: its only production call site was the WASM host, so for
 * a JS extension no denial was ever reachable. These tests pin the two
 * properties that stop this one going the same way — enforcement happens on the
 * host side, and every dangerous member stays mapped to a capability.
 */

import { describe, expect, it } from 'bun:test';
import {
  CAPABILITIES,
  CAPABILITY_CONTRACT_VERSION,
  CapabilityDeniedError,
  INTERNALS_CAPABILITY,
  declaredNetHosts,
  gateInternals,
  isKnownCapability,
  isLegacyLabel,
} from '../../lib/extensions/capabilities.js';

function fakeInternals() {
  return {
    decryptSecret: () => 'plaintext',
    createBetterAuthSession: () => 'session',
    enqueueDDLJob: () => 'job',
    generatePDF: () => 'pdf',
    // Ungated helper — no ambient authority.
    validatePublicUrl: () => undefined,
  };
}

describe('gateInternals', () => {
  it('allows a member whose capability is declared', () => {
    const g = gateInternals('ai', fakeInternals(), ['secrets']);
    expect(g.decryptSecret()).toBe('plaintext');
  });

  it('throws on a member whose capability is missing', () => {
    const g = gateInternals('ai', fakeInternals(), []);
    expect(() => g.decryptSecret()).toThrow(CapabilityDeniedError);
  });

  it('names the extension, the member and the capability to add', () => {
    const g = gateInternals('rogue-ext', fakeInternals(), []);
    try {
      g.createBetterAuthSession();
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('rogue-ext');
      expect(msg).toContain('createBetterAuthSession');
      expect(msg).toContain('auth:session');
    }
  });

  it('throws at CALL time, not at property access', () => {
    // Extensions destructure at module scope: `const { decryptSecret } = ctx.internals`.
    // Throwing on access would fail the load with a stack pointing nowhere near
    // the offending call.
    const g = gateInternals('ai', fakeInternals(), []);
    const { decryptSecret } = g;
    expect(typeof decryptSecret).toBe('function');
    expect(() => decryptSecret()).toThrow(CapabilityDeniedError);
  });

  it('leaves ungated helpers reachable', () => {
    const g = gateInternals('ai', fakeInternals(), []);
    expect(() => g.validatePublicUrl()).not.toThrow();
  });

  it('grants each capability independently', () => {
    const g = gateInternals('ai', fakeInternals(), ['secrets']);
    expect(() => g.decryptSecret()).not.toThrow();
    expect(() => g.enqueueDDLJob()).toThrow(CapabilityDeniedError);
  });

  it('is not fooled by a near-miss capability string', () => {
    // A typo must deny, not grant — the manifest schema rejects unknown values,
    // but the gate cannot assume it was the only way in.
    const g = gateInternals('ai', fakeInternals(), ['secret', 'db-admin', 'SECRETS']);
    expect(() => g.decryptSecret()).toThrow(CapabilityDeniedError);
  });
});

describe('capability vocabulary', () => {
  it('accepts every declared capability', () => {
    for (const c of CAPABILITIES) expect(isKnownCapability(c)).toBe(true);
  });

  it('accepts net:<host> and extracts the hosts', () => {
    expect(isKnownCapability('net:api.stripe.com')).toBe(true);
    expect(isKnownCapability('net:*.example.com:8443')).toBe(true);
    expect(declaredNetHosts(['secrets', 'net:a.com', 'net:b.com:443'])).toEqual([
      'a.com',
      'b.com:443',
    ]);
  });

  it('rejects an unknown or malformed value', () => {
    for (const bad of ['', 'db-admin', 'secrets ', 'net:', 'net:has space', 'arbitrary']) {
      expect(isKnownCapability(bad)).toBe(false);
    }
  });

  it('still accepts the legacy labels the catalogue already declares', () => {
    // 55 manifests declare `database`. Rejecting it would fail every one of
    // them on load for no security gain — it grants nothing either way.
    for (const legacy of ['database', 'storage', 'settings', 'network']) {
      expect(isKnownCapability(legacy)).toBe(true);
      expect(isLegacyLabel(legacy)).toBe(true);
    }
  });

  it('grants nothing for a legacy label', () => {
    const g = gateInternals('ai', fakeInternals(), ['database', 'storage', 'network']);
    expect(() => g.decryptSecret()).toThrow(CapabilityDeniedError);
    expect(() => g.enqueueDDLJob()).toThrow(CapabilityDeniedError);
  });

  it('has a contract version to pin against', () => {
    expect(CAPABILITY_CONTRACT_VERSION).toBeGreaterThan(0);
  });
});

describe('INTERNALS_CAPABILITY coverage', () => {
  it('maps every member to a capability that exists', () => {
    for (const [member, cap] of Object.entries(INTERNALS_CAPABILITY)) {
      expect(CAPABILITIES).toContain(cap);
      expect(member.length).toBeGreaterThan(0);
    }
  });

  it('gates the members that carry real authority', () => {
    // This list is the point of the contract. If someone removes an entry, the
    // capability stops being enforced silently — exactly how hasCapability died.
    for (const member of [
      'decryptSecret',
      'encryptSecret',
      'createBetterAuthSession',
      'enqueueDDLJob',
      'runEdgeFunction',
      'sendNotification',
      'moveToTrash',
      'generatePDF',
      'introspectSchema',
    ]) {
      expect(INTERNALS_CAPABILITY[member]).toBeTruthy();
    }
  });
});
