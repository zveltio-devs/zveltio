/**
 * Marketplace publisher-tier resolution (lib/extensions/extension-catalog.ts) —
 * the pure policy that decides whether an extension may run inline vs. must be
 * worker-isolated. Security-relevant (MARKETPLACE-POLICY §2).
 */

import { describe, it, expect } from 'bun:test';
import { resolvePublisherTier, tierAllowsInline } from '../../lib/extensions/extension-catalog.js';

describe('resolvePublisherTier', () => {
  it('uses an explicit publisher_tier when present (overrides is_official)', () => {
    expect(resolvePublisherTier({ publisher_tier: 'verified' })).toBe('verified');
    expect(resolvePublisherTier({ publisher_tier: 'community', is_official: true })).toBe(
      'community',
    );
  });

  it('falls back to is_official for legacy catalogs', () => {
    expect(resolvePublisherTier({ is_official: true })).toBe('first-party');
    expect(resolvePublisherTier({ is_official: false })).toBe('community');
    expect(resolvePublisherTier({})).toBe('community');
  });
});

describe('tierAllowsInline', () => {
  it('permits first-party + verified inline, forces community to worker isolation', () => {
    expect(tierAllowsInline('first-party')).toBe(true);
    expect(tierAllowsInline('verified')).toBe(true);
    expect(tierAllowsInline('community')).toBe(false);
  });
});
