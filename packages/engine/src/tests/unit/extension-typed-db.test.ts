import { describe, it, expect } from 'bun:test';
import type { Kysely } from 'kysely';
import type { ZveltioExtension, ExtensionContext } from '@zveltio/sdk/extension';

/**
 * Type-level test for S4-02: verify that the new `DB` generic on
 * `ZveltioExtension<DB>` and `ExtensionContext<DB>` actually flows through
 * to `ctx.db: Kysely<DB>`. The whole point is editor autocomplete +
 * compile-time typo detection on extension code.
 *
 * Bun's test runner only checks runtime behaviour, but TypeScript itself
 * is the test here: if these assertions don't compile, S4-02 regressed.
 */

interface FormsDB {
  zv_forms: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    fields: Record<string, unknown>;
    active: boolean;
  };
  zv_form_submissions: {
    id: string;
    form_id: string;
    data: Record<string, unknown>;
    created_at: Date;
  };
}

describe('S4-02 typed ctx.db', () => {
  it('untyped extension still compiles (default DB = any)', () => {
    const untyped: ZveltioExtension = {
      name: 'x',
      category: 'test',
      async register(_app, ctx) {
        // ctx.db is Kysely<any>; selectFrom accepts any table name.
        // Just verify the value flows.
        const builder = ctx.db.selectFrom('anything');
        expect(builder).toBeDefined();
      },
    };
    expect(untyped.name).toBe('x');
  });

  it('typed extension narrows table + column names through Kysely<DB>', () => {
    // Type-only assertion: ctx is ExtensionContext<FormsDB>, so ctx.db
    // is Kysely<FormsDB>. The Kysely builder API restricts selectFrom
    // to keyof FormsDB at compile time. This test compiling is the
    // assertion — any drift in S4-02 breaks `bun run typecheck`.
    const typed: ZveltioExtension<FormsDB> = {
      name: 'forms',
      category: 'forms',
      async register(_app, ctx) {
        // selectFrom only autocompletes / accepts 'zv_forms' | 'zv_form_submissions'.
        const _qb = ctx.db.selectFrom('zv_forms').selectAll();
        // Compile-time error site: 'zv_unknown' is NOT in FormsDB.
        // @ts-expect-error
        ctx.db.selectFrom('zv_unknown');

        // Column-level narrowing: `name` exists on zv_forms.
        ctx.db.selectFrom('zv_forms').select('name');
        // @ts-expect-error — `nonexistent` is not a column on zv_forms.
        ctx.db.selectFrom('zv_forms').select('nonexistent');
      },
    };
    expect(typed.name).toBe('forms');
  });

  it('handler context inherits the same DB generic', () => {
    // ExtensionContext<DB> handler signatures (events, schedules) should
    // see the typed db too. This compiles only if the propagation works.
    const typed: ZveltioExtension<FormsDB> = {
      name: 'forms',
      category: 'forms',
      async register(_app, _ctx) { /* no-op */ },
      schedules() {
        return [
          {
            name: 'cleanup',
            intervalMs: 60_000,
            handler: async (ctx) => {
              // ctx here is ExtensionContext<FormsDB>
              ctx.db.selectFrom('zv_form_submissions').selectAll();
            },
          },
        ];
      },
    };
    expect(typed.schedules?.()[0].name).toBe('cleanup');
  });

  it('legacy extensions using untyped ctx.db keep working', () => {
    // Spread of values without explicit annotation. Backward compat:
    // the 47 existing extensions don't change a line of code.
    const legacy = {
      name: 'sample',
      category: 'test',
      async register(_app: any, ctx: ExtensionContext) {
        // ctx.db is Kysely<any>; selectFrom takes string.
        return ctx.db.selectFrom('whatever' as any).selectAll().execute().then(() => {});
      },
    } satisfies ZveltioExtension;
    expect(legacy.name).toBe('sample');
  });
});

// Sanity: the imports we used resolve to real types.
type _AssertKysely = Kysely<FormsDB>;
type _AssertCtx = ExtensionContext<FormsDB>;
