/**
 * flow-step-schemas.ts — send_sms message length validation.
 */

import { describe, expect, it } from 'bun:test';
import { validateStepConfig } from '../../lib/flows/flow-step-schemas.js';

describe('validateStepConfig — send_sms bounds', () => {
  it('rejects messages longer than 1600 characters', () => {
    const r = validateStepConfig('send_sms', {
      to: '+15551234',
      message: 'x'.repeat(1601),
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('message'))).toBe(true);
  });

  it('accepts a message at the 1600 character limit', () => {
    const r = validateStepConfig('send_sms', {
      to: '+15551234',
      message: 'y'.repeat(1600),
    });
    expect(r.valid).toBe(true);
  });
});
