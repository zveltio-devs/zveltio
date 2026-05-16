import { describe, it, expect } from 'bun:test';
import type { FormSchema, FormAlterHook, SlotContribution } from '@zveltio/sdk/extension';

/**
 * Unit tests for the pure form-alter pipeline and slot sorting (S3-02 + S3-03).
 *
 * Imports the plain `.ts` helpers — NOT the `.svelte.ts` registries — so the
 * tests run under `bun:test` without Svelte's preprocessor. The reactive
 * registries themselves are thin wrappers around these helpers (see
 * `extension-api.svelte.ts`), so covering the pure side is sufficient to
 * guarantee correctness of the contributions surface.
 */

import {
  makeFormProxy,
  applyFormAlterHooks,
  sortSlotContributions,
} from '@zveltio/sdk/studio';

// ── Helpers ─────────────────────────────────────────────────────────────────

function userEditSchema(): FormSchema {
  return {
    id: 'core:user-edit',
    fields: [
      { name: 'name', type: 'text', label: 'Name', required: true },
      { name: 'email', type: 'email', label: 'Email', required: true },
      { name: 'legacy_pin', type: 'text', label: 'Legacy PIN' },
    ],
  };
}

// ── Form proxy: addField ────────────────────────────────────────────────────

describe('S3-02 form proxy: addField', () => {
  it('appends a field when no anchor is given', () => {
    const p = makeFormProxy(userEditSchema());
    p.addField({ field: { name: 'phone', type: 'tel' } });
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['name', 'email', 'legacy_pin', 'phone']);
  });

  it('inserts a field AFTER an existing anchor', () => {
    const p = makeFormProxy(userEditSchema());
    p.addField({ after: 'name', field: { name: 'middle', type: 'text' } });
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['name', 'middle', 'email', 'legacy_pin']);
  });

  it('inserts a field BEFORE an existing anchor', () => {
    const p = makeFormProxy(userEditSchema());
    p.addField({ before: 'email', field: { name: 'username', type: 'text' } });
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['name', 'username', 'email', 'legacy_pin']);
  });

  it('appends with a warning when the anchor is missing', () => {
    const p = makeFormProxy(userEditSchema());
    p.addField({ after: 'nonexistent', field: { name: 'x', type: 'text' } });
    const out = p.commit();
    expect(out.fields[out.fields.length - 1].name).toBe('x');
  });

  it('refuses to add a field with the same name twice', () => {
    const p = makeFormProxy(userEditSchema());
    p.addField({ field: { name: 'email', type: 'text' } });
    const out = p.commit();
    expect(out.fields.filter((f) => f.name === 'email')).toHaveLength(1);
  });

  it('does not leak validator arrays back to the input', () => {
    const schema = userEditSchema();
    const validator = () => null;
    const p = makeFormProxy(schema);
    p.addField({ field: { name: 'phone', type: 'tel', validators: [validator] } });
    p.commit();
    // The original schema must not have been mutated.
    expect(schema.fields.map((f) => f.name)).toEqual(['name', 'email', 'legacy_pin']);
  });
});

// ── Form proxy: hideField ───────────────────────────────────────────────────

describe('S3-02 form proxy: hideField', () => {
  it('marks the field hidden in the committed schema', () => {
    const p = makeFormProxy(userEditSchema());
    p.hideField('legacy_pin');
    const out = p.commit();
    expect(out.fields.find((f) => f.name === 'legacy_pin')?.hidden).toBe(true);
  });

  it('does not remove the field — server-side defaults still apply', () => {
    const p = makeFormProxy(userEditSchema());
    p.hideField('legacy_pin');
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['name', 'email', 'legacy_pin']);
  });

  it('hiding a non-existent field is silent and idempotent', () => {
    const p = makeFormProxy(userEditSchema());
    p.hideField('does-not-exist');
    p.hideField('also-missing');
    const out = p.commit();
    expect(out.fields.every((f) => !f.hidden)).toBe(true);
  });
});

// ── Form proxy: reorder ─────────────────────────────────────────────────────

describe('S3-02 form proxy: reorder', () => {
  it('puts the listed fields first in the given order', () => {
    const p = makeFormProxy(userEditSchema());
    p.reorder(['email', 'name']);
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['email', 'name', 'legacy_pin']);
  });

  it('preserves the relative order of fields not in the reorder list', () => {
    const schema: FormSchema = {
      id: 'x',
      fields: [
        { name: 'a', type: 't' }, { name: 'b', type: 't' },
        { name: 'c', type: 't' }, { name: 'd', type: 't' },
      ],
    };
    const p = makeFormProxy(schema);
    p.reorder(['c', 'a']);
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('silently ignores names that do not exist', () => {
    const p = makeFormProxy(userEditSchema());
    p.reorder(['ghost', 'email']);
    const out = p.commit();
    expect(out.fields.map((f) => f.name)).toEqual(['email', 'name', 'legacy_pin']);
  });
});

// ── Form proxy: addValidator ────────────────────────────────────────────────

describe('S3-02 form proxy: addValidator', () => {
  it('attaches a validator to an existing field', () => {
    const p = makeFormProxy(userEditSchema());
    const v = (val: unknown) => (typeof val === 'string' && val.startsWith('+')) ? null : 'Must start with +';
    p.addValidator('email', v);
    const out = p.commit();
    const validators = out.fields.find((f) => f.name === 'email')?.validators ?? [];
    expect(validators).toHaveLength(1);
    expect(validators[0]('foo')).toBe('Must start with +');
    expect(validators[0]('+1234')).toBeNull();
  });

  it('chains multiple validators in registration order', () => {
    const p = makeFormProxy(userEditSchema());
    p.addValidator('email', () => 'first');
    p.addValidator('email', () => 'second');
    const out = p.commit();
    const vs = out.fields.find((f) => f.name === 'email')?.validators ?? [];
    expect(vs.map((v) => v(''))).toEqual(['first', 'second']);
  });

  it('warns and skips when the field does not exist', () => {
    const p = makeFormProxy(userEditSchema());
    p.addValidator('ghost', () => 'never');
    const out = p.commit();
    // Real fields still have empty validator arrays (no spillover).
    expect(out.fields.every((f) => (f.validators ?? []).length === 0)).toBe(true);
  });
});

// ── applyFormAlterHooks: pipeline integration ───────────────────────────────

describe('S3-02 applyFormAlterHooks', () => {
  it('runs every hook in order against the schema', () => {
    const a: FormAlterHook = (form) => form.addField({ after: 'name', field: { name: 'phone', type: 'tel' } });
    const b: FormAlterHook = (form) => form.hideField('legacy_pin');
    const out = applyFormAlterHooks([a, b], userEditSchema());
    expect(out.fields.map((f) => f.name)).toEqual(['name', 'phone', 'email', 'legacy_pin']);
    expect(out.fields.find((f) => f.name === 'legacy_pin')?.hidden).toBe(true);
  });

  it('keeps running subsequent hooks when one throws', () => {
    const throwing: FormAlterHook = () => { throw new Error('boom'); };
    const good: FormAlterHook = (form) => form.hideField('email');
    const out = applyFormAlterHooks([throwing, good], userEditSchema());
    expect(out.fields.find((f) => f.name === 'email')?.hidden).toBe(true);
  });

  it('returns the original schema when there are no hooks', () => {
    const schema = userEditSchema();
    const out = applyFormAlterHooks([], schema);
    expect(out).toBe(schema);
  });

  it('forwards ctx to hooks so visibility/auth-aware logic works', () => {
    const seenBag: { ctx: Record<string, unknown> | null } = { ctx: null };
    const h: FormAlterHook = (_form, ctx) => { seenBag.ctx = ctx; };
    applyFormAlterHooks([h], userEditSchema(), { user: { roles: ['admin'] } });
    expect(seenBag.ctx).toEqual({ user: { roles: ['admin'] } });
  });
});

// ── Slot sorting ────────────────────────────────────────────────────────────

describe('S3-03 sortSlotContributions', () => {
  function c(priority: number | undefined, tag: string): SlotContribution & { __tag: string } {
    return { component: {}, priority, __tag: tag } as any;
  }

  it('sorts ascending by priority (lower runs first)', () => {
    const items = [c(50, 'mid'), c(10, 'first'), c(100, 'last')];
    const sorted = sortSlotContributions(items);
    expect(sorted.map((x: any) => x.__tag)).toEqual(['first', 'mid', 'last']);
  });

  it('treats missing priority as 100 (the documented default)', () => {
    const items = [c(undefined, 'default'), c(50, 'before'), c(150, 'after')];
    const sorted = sortSlotContributions(items);
    expect(sorted.map((x: any) => x.__tag)).toEqual(['before', 'default', 'after']);
  });

  it('is stable for equal priorities (preserves registration order)', () => {
    const items = [c(50, 'a'), c(50, 'b'), c(50, 'c')];
    const sorted = sortSlotContributions(items);
    expect(sorted.map((x: any) => x.__tag)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const items = [c(99, 'a'), c(1, 'b')];
    const before = items.map((x: any) => x.__tag);
    sortSlotContributions(items);
    expect(items.map((x: any) => x.__tag)).toEqual(before);
  });
});
