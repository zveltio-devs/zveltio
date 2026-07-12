/**
 * flow-step-schemas.ts — webhook default method, headers, timeout_ms.
 */

import { describe, expect, it } from 'bun:test';
import { validateStepConfig } from '../../lib/flows/flow-step-schemas.js';

describe('validateStepConfig — webhook defaults', () => {
  it('applies POST method, empty headers, and 10s timeout by default', () => {
    const r = validateStepConfig('webhook', { url: 'https://hooks.example.com/in' });
    expect(r.valid).toBe(true);
    expect(r.config?.method).toBe('POST');
    expect(r.config?.headers).toEqual({});
    expect(r.config?.timeout_ms).toBe(10_000);
  });

  it('accepts a template url and custom method', () => {
    const r = validateStepConfig('webhook', {
      url: '{{ctx.webhook_url}}',
      method: 'PUT',
      headers: { Authorization: 'Bearer x' },
      timeout_ms: 2000,
    });
    expect(r.valid).toBe(true);
    expect(r.config?.method).toBe('PUT');
    expect(r.config?.headers).toEqual({ Authorization: 'Bearer x' });
    expect(r.config?.timeout_ms).toBe(2000);
  });
});
