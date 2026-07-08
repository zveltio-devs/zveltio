/**
 * Engine/extension version compatibility (lib/version-checker.ts) — pure semver
 * gate used by the extension load pipeline (H-04/load-phases).
 */

import { describe, it, expect } from 'bun:test';
import { getEngineVersion, isCompatible } from '../../lib/version-checker.js';

describe('isCompatible', () => {
  it('no min bound → always compatible', () => {
    expect(isCompatible('3.0.0')).toEqual({ compatible: true });
    expect(isCompatible('0.1.0', null)).toEqual({ compatible: true });
  });

  it('engine above/equal the min → compatible', () => {
    expect(isCompatible('3.0.0', '2.0.0').compatible).toBe(true);
    expect(isCompatible('3.0.0', '3.0.0').compatible).toBe(true); // equal
    expect(isCompatible('3.1.0', '3.0.0').compatible).toBe(true);
  });

  it('engine below the min → incompatible with a >= reason', () => {
    const r = isCompatible('3.0.0', '4.0.0');
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain('Requires engine >= 4.0.0');
  });

  it('engine above the max → incompatible with a <= reason', () => {
    const r = isCompatible('3.0.0', '2.0.0', '2.5.0');
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain('Requires engine <= 2.5.0');
  });

  it('engine within [min, max] (inclusive) → compatible', () => {
    expect(isCompatible('3.1.0', '3.0.0', '3.2.0').compatible).toBe(true);
    expect(isCompatible('3.2.0', '3.0.0', '3.2.0').compatible).toBe(true); // equal max
  });
});

describe('getEngineVersion', () => {
  it('returns a non-empty version string', () => {
    expect(typeof getEngineVersion()).toBe('string');
    expect(getEngineVersion().length).toBeGreaterThan(0);
  });
});
