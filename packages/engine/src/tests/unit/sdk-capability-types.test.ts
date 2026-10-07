// The SDK's capability types mirror the engine's capability contract (R8).
//
// `defineExtension(['secrets'], …)` narrows `ctx.internals` to what the
// declared capabilities unlock, using tables the SDK carries. If they drift from
// the engine's, the compiler either refuses a member the engine allows or, worse,
// allows one the engine will refuse at runtime — the exact surprise the types
// exist to prevent. So the tables are compared here, and the narrowing itself is
// held by `@ts-expect-error` lines below, which `bun run typecheck` reads: a
// member that stops being refused makes the directive unused, and that fails.
import { describe, expect, it } from 'bun:test';
import {
  CAPABILITY_MEMBERS,
  defineExtension,
  EXTENSION_CAPABILITIES,
} from '@zveltio/sdk/extension';
import { CAPABILITIES, INTERNALS_CAPABILITY } from '../../lib/extensions/capabilities.js';

describe('SDK capability types (R8)', () => {
  it('list the capabilities the engine knows', () => {
    expect([...EXTENSION_CAPABILITIES].sort()).toEqual([...CAPABILITIES].sort());
  });

  it("map each gated member to the engine's capability", () => {
    const sdk: Record<string, string> = { ...CAPABILITY_MEMBERS };
    expect(sdk).toEqual({ ...INTERNALS_CAPABILITY });
  });

  it('defineExtension returns the extension with its capabilities attached', () => {
    const ext = defineExtension(['secrets', 'ddl'], {
      name: 'typed',
      category: 'test',
      async register() {},
    });
    expect(ext.name).toBe('typed');
    expect(ext.capabilities).toEqual(['secrets', 'ddl']);
  });
});

// ── compile-time: what `ctx` lets an extension reach ───────────────────────
// Never run; type-checked by `bun run typecheck`.
export const _typedCtx = defineExtension(['secrets', 'data:system'], {
  name: 'typed-ctx',
  category: 'test',
  async register(_app, ctx) {
    // Declared: reachable.
    void ctx.internals.encryptSecret;
    void ctx.internals.asSystem;
    // Ungated: always reachable.
    void ctx.internals.getUserNames;
    void ctx.internals.withTenantIsolation;
    // @ts-expect-error — `deleteUser` needs 'auth:users', which is not declared.
    void ctx.internals.deleteUser;
    // @ts-expect-error — `enqueueDDLJob` needs 'ddl'.
    void ctx.internals.enqueueDDLJob;
    // @ts-expect-error — `adminDb` needs 'db:admin'.
    void ctx.adminDb?.selectFrom;
  },
});

// Without defineExtension nothing changes: every member is there, as before.
export const _untyped: import('@zveltio/sdk/extension').ZveltioExtension = {
  name: 'untyped',
  category: 'test',
  async register(_app, ctx) {
    void ctx.internals.deleteUser;
    void ctx.adminDb?.selectFrom;
  },
};
