/**
 * isSingleUnitReach — whether a handler may add `tenant_id = <id>` beside the
 * policy. A single visible tenant that is not the acting one must answer false:
 * the equality would hide every row the policy lets through.
 */

import { describe, expect, it } from 'bun:test';
import { isSingleUnitReach } from '../../lib/tenancy/tenant-manager.js';

const T = '00000000-0000-0000-0000-0000000000a1';
const U = '00000000-0000-0000-0000-0000000000b2';

describe('isSingleUnitReach', () => {
  it('is true for no scope, unbounded reach, and exactly the acting tenant', () => {
    expect(isSingleUnitReach(null, T)).toBe(true);
    expect(isSingleUnitReach({ visible: null } as never, T)).toBe(true);
    expect(isSingleUnitReach({ visible: [T] } as never, T)).toBe(true);
  });

  it('is false for one visible tenant that is not the acting one, or several', () => {
    expect(isSingleUnitReach({ visible: [U] } as never, T)).toBe(false);
    expect(isSingleUnitReach({ visible: [T, U] } as never, T)).toBe(false);
  });
});
