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

  // The engine is a prerelease. Split on '.', its patch read as NaN and every
  // comparison passed, so a beta minimum admitted an older beta.
  it('orders prereleases: beta.72 is below a beta.73 minimum', () => {
    const r = isCompatible('3.0.0-beta.72', '3.0.0-beta.73');
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain('Requires engine >= 3.0.0-beta.73');
    expect(isCompatible('3.0.0-beta.73', '3.0.0-beta.73').compatible).toBe(true);
    expect(isCompatible('3.0.0-beta.100', '3.0.0-beta.73').compatible).toBe(true);
    expect(isCompatible('3.0.0', '3.0.0-beta.73').compatible).toBe(true);
    expect(isCompatible('3.0.0-beta.72', '1.0.0', '4.0.0').compatible).toBe(true);
  });

  it('refuses a version that is not semver', () => {
    const r = isCompatible('3.0.0-beta.72', 'latest');
    expect(r.compatible).toBe(false);
    expect(r.reason).toContain('Invalid SemVer');
  });
});

describe('getEngineVersion', () => {
  it('returns a non-empty version string', () => {
    expect(typeof getEngineVersion()).toBe('string');
    expect(getEngineVersion().length).toBeGreaterThan(0);
  });
});
