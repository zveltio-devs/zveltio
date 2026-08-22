import { describe, expect, it } from 'bun:test';
import { resolvePackIsolation } from './pack-isolation.js';

describe('resolvePackIsolation', () => {
  it('injects worker for community when isolation is unset', () => {
    expect(resolvePackIsolation({ communityInject: true, firstParty: false })).toBe('worker');
  });

  it('keeps inline default for first-party when unset', () => {
    expect(resolvePackIsolation({ firstParty: true, communityInject: false })).toBeUndefined();
  });

  it('clears sticky worker on first-party pack', () => {
    expect(
      resolvePackIsolation({
        current: 'worker',
        firstParty: true,
      }),
    ).toBeUndefined();
  });

  it('retains worker on first-party when keepIsolation is set', () => {
    expect(
      resolvePackIsolation({
        current: 'worker',
        firstParty: true,
        keepIsolation: true,
      }),
    ).toBe('worker');
  });

  it('preserves explicit worker for community', () => {
    expect(
      resolvePackIsolation({
        current: 'worker',
        firstParty: false,
        communityInject: true,
      }),
    ).toBe('worker');
  });
});
