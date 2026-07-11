/**
 * Flow step config validation (lib/flows/flow-step-schemas.ts).
 */

import { describe, expect, it } from 'bun:test';
import {
  isKnownStepType,
  stepSchemas,
  validateStepConfig,
} from '../../lib/flows/flow-step-schemas.js';

describe('isKnownStepType', () => {
  it('returns true for every registered step type', () => {
    for (const t of Object.keys(stepSchemas)) {
      expect(isKnownStepType(t)).toBe(true);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isKnownStepType('not_a_step')).toBe(false);
    expect(isKnownStepType('')).toBe(false);
  });
});

describe('validateStepConfig — unknown type', () => {
  it('rejects an unknown step type with a helpful message', () => {
    const r = validateStepConfig('fly_to_moon', { foo: 1 });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('Unknown step type');
    expect(r.errors[0]).toContain('send_email');
    expect(r.config).toBeUndefined();
  });
});

describe('validateStepConfig — per-type happy paths', () => {
  it('run_script requires script and applies timeout_ms default', () => {
    const r = validateStepConfig('run_script', { script: 'return 1;' });
    expect(r.valid).toBe(true);
    expect(r.config?.timeout_ms).toBe(5_000);
  });

  it('send_email accepts a literal email or template placeholder', () => {
    expect(
      validateStepConfig('send_email', {
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Hello',
      }).valid,
    ).toBe(true);
    expect(
      validateStepConfig('send_email', {
        to: '{{user.email}}',
        subject: 'Hi',
        body: 'Hello',
      }).valid,
    ).toBe(true);
  });

  it('webhook accepts url or template and defaults method/headers', () => {
    const r = validateStepConfig('webhook', { url: 'https://example.com/hook' });
    expect(r.valid).toBe(true);
    expect(r.config?.method).toBe('POST');
    expect(r.config?.headers).toEqual({});
  });

  it('condition parses branch uuid arrays', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const r = validateStepConfig('condition', {
      expression: 'ctx.ok',
      true_branch: [id],
      false_branch: [],
    });
    expect(r.valid).toBe(true);
    expect(r.config?.true_branch).toEqual([id]);
  });

  it('delay enforces duration bounds', () => {
    expect(validateStepConfig('delay', { duration_ms: 500 }).valid).toBe(true);
    expect(validateStepConfig('delay', { duration_ms: 50 }).valid).toBe(false);
  });

  it('create_record / update_record / delete_record accept collection + data/id', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(
      validateStepConfig('create_record', { collection: 'posts', data: { title: 'x' } }).valid,
    ).toBe(true);
    expect(
      validateStepConfig('update_record', {
        collection: 'posts',
        id,
        data: { title: 'y' },
      }).valid,
    ).toBe(true);
    expect(
      validateStepConfig('delete_record', { collection: 'posts', id: '{{record.id}}' }).valid,
    ).toBe(true);
  });

  it('ai_decision requires at least two options', () => {
    expect(
      validateStepConfig('ai_decision', {
        prompt: 'classify',
        options: ['yes', 'no'],
      }).valid,
    ).toBe(true);
    expect(validateStepConfig('ai_decision', { prompt: 'x', options: ['only'] }).valid).toBe(false);
  });

  it('send_sms accepts phone or template in to', () => {
    expect(validateStepConfig('send_sms', { to: '+15551234', message: 'ping' }).valid).toBe(true);
    expect(validateStepConfig('send_sms', { to: '{{user.phone}}', message: 'ping' }).valid).toBe(
      true,
    );
  });

  it('transform accepts a template record', () => {
    const r = validateStepConfig('transform', { template: { out: '{{in}}' } });
    expect(r.valid).toBe(true);
  });

  it('loop applies defaults for item_alias, steps, max_iterations', () => {
    const r = validateStepConfig('loop', { items_key: 'items' });
    expect(r.valid).toBe(true);
    expect(r.config?.item_alias).toBe('item');
    expect(r.config?.steps).toEqual([]);
    expect(r.config?.max_iterations).toBe(100);
  });
});

describe('validateStepConfig — validation errors', () => {
  it('maps Zod issues to path-prefixed error strings', () => {
    const r = validateStepConfig('send_email', { to: 'not-an-email', subject: '', body: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.includes('subject'))).toBe(true);
  });

  it('treats null config as empty object (defaults still apply)', () => {
    const r = validateStepConfig('webhook', null);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('url'))).toBe(true);
  });
});
