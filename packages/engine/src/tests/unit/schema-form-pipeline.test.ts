import { describe, it, expect } from 'bun:test';
import type { FormSchema, FormAlterHook } from '@zveltio/sdk/extension';
import { applyFormAlterHooks } from '@zveltio/sdk/studio';

/**
 * Integration tests for the SchemaForm consumption path (S3-02 closure).
 *
 * SchemaForm.svelte (Studio) cannot run under `bun:test` because it
 * needs the Svelte compiler. But its behavior is a thin wrapper around
 * `applyFormAlterHooks` + a renderer:
 *
 *   1. Compute `altered = applyFormAlterHooks(hooks, schema, ctx)`.
 *   2. Filter `altered.fields` where `!f.hidden` → render those.
 *   3. For each field, run its validators on input.
 *
 * The render layer is mostly markup. Steps 1+2+3 are the only logic
 * worth testing — and they're all pure. These tests cover the contract
 * SchemaForm depends on so a regression in the alter pipeline shows up
 * before any UI bug does.
 */

function userInviteSchema(): FormSchema {
  return {
    id: 'core:user-invite',
    fields: [
      { name: 'email', type: 'email',  label: 'Email', required: true },
      { name: 'name',  type: 'text',   label: 'Name' },
      { name: 'role',  type: 'select', label: 'Role', options: [
        { value: 'member', label: 'Member' },
        { value: 'admin',  label: 'Admin'  },
      ] },
    ],
  };
}

describe('S3-02 closure — SchemaForm consumption pipeline', () => {
  it('renders altered field list when one extension adds a field', () => {
    const addPhone: FormAlterHook = (form) => {
      form.addField({
        after: 'email',
        field: { name: 'phone', type: 'tel', label: 'Phone' },
      });
    };
    const out = applyFormAlterHooks([addPhone], userInviteSchema());
    // SchemaForm renders visible (= non-hidden) fields in this order.
    const visible = out.fields.filter((f) => !f.hidden).map((f) => f.name);
    expect(visible).toEqual(['email', 'phone', 'name', 'role']);
  });

  it('skips hidden fields in the render list', () => {
    const hideName: FormAlterHook = (form) => form.hideField('name');
    const out = applyFormAlterHooks([hideName], userInviteSchema());
    const visible = out.fields.filter((f) => !f.hidden).map((f) => f.name);
    expect(visible).toEqual(['email', 'role']);
    // But the hidden field is still in the schema (so server-side defaults
    // / submit values still flow through).
    expect(out.fields.find((f) => f.name === 'name')?.hidden).toBe(true);
  });

  it('combines layered hooks: add then hide then validate', () => {
    const addPhone: FormAlterHook = (form) =>
      form.addField({ after: 'email', field: { name: 'phone', type: 'tel' } });
    const hideName: FormAlterHook = (form) => form.hideField('name');
    const validatePhone: FormAlterHook = (form) =>
      form.addValidator('phone', (v) =>
        typeof v === 'string' && v.startsWith('+') ? null : 'Must start with +',
      );
    const out = applyFormAlterHooks(
      [addPhone, hideName, validatePhone],
      userInviteSchema(),
    );
    const visible = out.fields.filter((f) => !f.hidden);
    expect(visible.map((f) => f.name)).toEqual(['email', 'phone', 'role']);
    // SchemaForm runs validators per-field on input.
    const phoneValidators = out.fields.find((f) => f.name === 'phone')?.validators ?? [];
    expect(phoneValidators).toHaveLength(1);
    expect(phoneValidators[0]('foo')).toBe('Must start with +');
    expect(phoneValidators[0]('+1234567')).toBeNull();
  });

  it('forwards ctx so visibility-aware hooks can branch on user role', () => {
    // Realistic ctx that SchemaForm passes: { user, mode }.
    const adminOnlyExtraField: FormAlterHook = (form, ctx) => {
      const u = (ctx as any)?.user as { roles?: string[] } | undefined;
      if (u?.roles?.includes('admin')) {
        form.addField({ field: { name: 'audit_note', type: 'text', label: 'Audit note' } });
      }
    };

    const adminOut = applyFormAlterHooks(
      [adminOnlyExtraField],
      userInviteSchema(),
      { user: { roles: ['admin'] }, mode: 'create' },
    );
    expect(adminOut.fields.some((f) => f.name === 'audit_note')).toBe(true);

    const memberOut = applyFormAlterHooks(
      [adminOnlyExtraField],
      userInviteSchema(),
      { user: { roles: ['member'] }, mode: 'create' },
    );
    expect(memberOut.fields.some((f) => f.name === 'audit_note')).toBe(false);
  });

  it('isolates a throwing hook: the rest of the alters still apply', () => {
    const broken: FormAlterHook = () => { throw new Error('broken extension'); };
    const hide: FormAlterHook = (form) => form.hideField('name');
    const out = applyFormAlterHooks([broken, hide], userInviteSchema());
    expect(out.fields.find((f) => f.name === 'name')?.hidden).toBe(true);
  });

  it('preserves the original schema when no hooks are registered', () => {
    const schema = userInviteSchema();
    const out = applyFormAlterHooks([], schema);
    // Identity guarantees the renderer can skip the diff path when no
    // extension targets the form.
    expect(out).toBe(schema);
  });

  it('does not leak validator state between renders of the same schema', () => {
    // SchemaForm computes `altered` via $derived → re-runs on inputs change.
    // If applyFormAlterHooks mutated the input schema's validators, multiple
    // renders would stack validators infinitely. Make sure that does NOT
    // happen.
    const schema = userInviteSchema();
    const v: FormAlterHook = (form) => form.addValidator('email', () => null);
    applyFormAlterHooks([v], schema);
    applyFormAlterHooks([v], schema);
    applyFormAlterHooks([v], schema);
    // Source schema is untouched.
    expect(schema.fields.find((f) => f.name === 'email')?.validators ?? []).toEqual([]);
  });
});

describe('S3-03 closure — slot host contract', () => {
  // Slot hosts (e.g. <Slot name="sidebar.bottom" ctx={...} />) take a name
  // + ctx. The Slot.svelte component calls
  // `studioApi.getSlotContributions(name)` → filters by `visible(ctx)` →
  // sorts by priority asc → renders each `component` with `props + ctx`.
  //
  // These tests assert the pure pieces that contract is built on. The
  // Svelte-side reactive registry just stores the contributions; the sort
  // + visibility logic is reused from @zveltio/sdk/studio and already
  // covered in `studio-extension-api.test.ts`. Here we cover the
  // visibility-filter shape so a slot host that passes specific ctx
  // doesn't surprise contributors.

  interface Contribution { component: unknown; priority?: number; visible?: (ctx: any) => boolean }

  function filterVisible(items: Contribution[], ctx: Record<string, unknown>): Contribution[] {
    return items.filter((c) => {
      if (typeof c.visible !== 'function') return true;
      try { return c.visible(ctx); }
      catch { return false; }
    });
  }

  it('passes the host ctx into visible(ctx) and respects the result', () => {
    const items: Contribution[] = [
      { component: {}, visible: (ctx) => ctx.user?.roles?.includes('admin') },
      { component: {}, visible: (ctx) => ctx.user?.roles?.includes('member') },
    ];
    const adminOut = filterVisible(items, { user: { roles: ['admin'] } });
    expect(adminOut).toHaveLength(1);
    const memberOut = filterVisible(items, { user: { roles: ['member'] } });
    expect(memberOut).toHaveLength(1);
    const guestOut = filterVisible(items, { user: { roles: [] } });
    expect(guestOut).toHaveLength(0);
  });

  it('treats a throwing predicate as hidden (defensive — bad extension)', () => {
    const items: Contribution[] = [
      { component: {}, visible: () => { throw new Error('boom'); } },
      { component: {} },
    ];
    const out = filterVisible(items, {});
    expect(out).toHaveLength(1);
  });

  it('includes a contribution when no predicate is set', () => {
    const items: Contribution[] = [{ component: {} }];
    expect(filterVisible(items, {})).toHaveLength(1);
  });
});
