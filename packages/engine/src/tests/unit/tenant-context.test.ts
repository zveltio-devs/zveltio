/**
 * tenant-context.ts — AsyncLocalStorage domain + tenant transaction binding.
 */

import { describe, expect, it } from 'bun:test';
import {
  getCurrentDomain,
  getCurrentTenantTrx,
  runWithDomain,
  setCurrentTenantTrx,
} from '../../lib/tenancy/tenant-context.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';

describe('tenant context ALS', () => {
  it('returns the default tenant outside a store', () => {
    expect(getCurrentDomain()).toBe(DEFAULT_TENANT_ID);
    expect(getCurrentTenantTrx()).toBeUndefined();
  });

  it('scopes getCurrentDomain to runWithDomain', () => {
    runWithDomain('tenant-acme', () => {
      expect(getCurrentDomain()).toBe('tenant-acme');
    });
    expect(getCurrentDomain()).toBe(DEFAULT_TENANT_ID);
  });

  it('records and returns the active tenant transaction in the store', () => {
    const trx = { tag: 'tenant-trx' };
    runWithDomain('tenant-x', () => {
      setCurrentTenantTrx(trx as never);
      expect(getCurrentTenantTrx() as unknown).toBe(trx);
    });
    expect(getCurrentTenantTrx()).toBeUndefined();
  });

  it('setCurrentTenantTrx is a no-op outside runWithDomain', () => {
    setCurrentTenantTrx({ tag: 'orphan' } as never);
    expect(getCurrentTenantTrx()).toBeUndefined();
  });
});
