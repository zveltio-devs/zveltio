/**
 * flow-step-schemas.ts — delay duration upper bound (24h).
 */

import { describe, expect, it } from 'bun:test';
import { validateStepConfig } from '../../lib/flows/flow-step-schemas.js';

describe('validateStepConfig — delay bounds', () => {
  it('accepts the maximum 24h delay', () => {
    const r = validateStepConfig('delay', { duration_ms: 86_400_000 });
    expect(r.valid).toBe(true);
  });

  it('rejects delays above 24 hours', () => {
    const r = validateStepConfig('delay', { duration_ms: 86_400_001 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('duration_ms'))).toBe(true);
  });
});
