/**
 * flow-step-schemas.ts — additional validation branches.
 */

import { describe, expect, it } from 'bun:test';
import { validateStepConfig } from '../../lib/flows/flow-step-schemas.js';

describe('validateStepConfig — edge cases', () => {
  it('run_script rejects missing script', () => {
    const r = validateStepConfig('run_script', {});
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('script'))).toBe(true);
  });

  it('send_email rejects a non-email literal without template syntax', () => {
    const r = validateStepConfig('send_email', {
      to: 'not-an-email',
      subject: 'Hi',
      body: 'x',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('to'))).toBe(true);
  });

  it('condition rejects non-uuid branch ids', () => {
    const r = validateStepConfig('condition', {
      expression: 'ctx.ok',
      true_branch: ['not-a-uuid'],
      false_branch: [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('true_branch'))).toBe(true);
  });

  it('webhook rejects an invalid url literal', () => {
    const r = validateStepConfig('webhook', { url: 'ftp://bad scheme' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('url'))).toBe(true);
  });

  it('ai_decision rejects empty options array', () => {
    const r = validateStepConfig('ai_decision', { prompt: 'pick', options: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('options'))).toBe(true);
  });
});
