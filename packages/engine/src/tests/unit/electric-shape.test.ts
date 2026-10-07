import { describe, expect, it } from 'bun:test';
import {
  buildShapeDefinition,
  MAX_SHAPE_TENANTS,
  type ShapeInput,
  shapeSearchParams,
} from '../../lib/tenancy/electric-shape.js';

/**
 * The shape one caller may sync — table, columns, WHERE — built by the engine.
 * Electric bypasses RLS, so every refusal here is a row or column that would
 * otherwise reach the client. The live behaviour against a real Electric is in
 * tests/harness/electric-shapes.test.ts; operator parity with the other four
 * appliers in tests/harness/row-rules-four-interpreters.test.ts.
 */

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

function input(over: Partial<ShapeInput> & { hidden?: string[] } = {}): ShapeInput {
  const hidden = new Set(over.hidden ?? []);
  return {
    table: 'zvd_notes',
    columns: ['id', 'tenant_id', 'title', 'secret', 'owner', 'search_vector', 'search_text', 'enc'],
    withheld: new Set(['enc']),
    tenants: [A],
    ...over,
    scope: {
      rls: [],
      readable: (c: string) => !hidden.has('*') && !hidden.has(c),
      altersRestrict: false,
      entityChecks: false,
      ...over.scope,
    },
  };
}

const ok = (def: ReturnType<typeof buildShapeDefinition>) => {
  if (!def.ok) throw new Error(`refused: ${def.code} ${def.detail}`);
  return def;
};

describe('buildShapeDefinition', () => {
  it('filters on the request tenant, as a param, never inlined', () => {
    const def = ok(buildShapeDefinition(input()));
    expect(def.where).toBe('(tenant_id IN ($1))');
    expect(def.params).toEqual([A]);
  });

  it('a subtree reach lists every visible tenant', () => {
    const def = ok(buildShapeDefinition(input({ tenants: [A, B] })));
    expect(def.where).toBe('(tenant_id IN ($1, $2))');
    expect(def.params).toEqual([A, B]);
  });

  it("god's reach is every tenant: no tenant clause", () => {
    expect(ok(buildShapeDefinition(input({ tenants: 'all' }))).where).toBeNull();
  });

  it('an empty reach reads nothing', () => {
    expect(ok(buildShapeDefinition(input({ tenants: [] }))).where).toBe('(false)');
  });

  it('a reach Electric cannot carry is refused, not truncated', () => {
    const many = Array.from({ length: MAX_SHAPE_TENANTS + 1 }, () => crypto.randomUUID());
    const def = buildShapeDefinition(input({ tenants: many }));
    expect(def.ok ? null : def.code).toBe('electric.reach_too_wide');
  });

  it('a table with no tenant_id is refused unless the reach is every tenant', () => {
    const columns = ['id', 'title'];
    const def = buildShapeDefinition(input({ columns }));
    expect(def.ok ? null : def.code).toBe('electric.untenanted');
    expect(buildShapeDefinition(input({ columns, tenants: 'all' })).ok).toBe(true);
  });

  it('hidden, internal and encrypted columns are never selected', () => {
    const def = ok(buildShapeDefinition(input({ hidden: ['secret'] })));
    expect(def.columns).toEqual(['id', 'tenant_id', 'title', 'owner']);
  });

  it('a hidden primary key, or every column hidden, refuses the shape', () => {
    for (const hidden of [['id'], ['*']]) {
      const def = buildShapeDefinition(input({ hidden }));
      expect(def.ok ? null : def.code).toBe('electric.columns');
    }
  });

  it('compiles each row rule with the SQL operator and params', () => {
    const def = ok(
      buildShapeDefinition(
        input({
          scope: {
            rls: [
              { field: 'owner', condition: { op: 'eq', value: 'user-1' } },
              { field: 'title', condition: { op: 'neq', value: 'x' } },
              { field: 'title', condition: { op: 'in', value: ['a', 'b'] } },
              { field: 'owner', condition: { op: 'not_in', value: ['z'] } },
            ],
          } as never,
        }),
      ),
    );
    expect(def.where).toBe(
      '(tenant_id IN ($1)) AND ("owner" = $2) AND ("title" <> $3) AND ' +
        '("title" IN ($4, $5)) AND ("owner" NOT IN ($6))',
    );
    expect(def.params).toEqual([A, 'user-1', 'x', 'a', 'b', 'z']);
  });

  it('a rule on a hidden column still filters (the server reads it, the client does not)', () => {
    const def = ok(
      buildShapeDefinition(
        input({
          hidden: ['secret'],
          scope: { rls: [{ field: 'secret', condition: { op: 'eq', value: 's' } }] } as never,
        }),
      ),
    );
    expect(def.where).toContain('"secret" = $2');
    expect(def.columns).not.toContain('secret');
  });

  it('the empty-list sentinels mean what the other appliers mean', () => {
    const rls = [
      { field: 'title', condition: { op: 'in', value: [] } },
      { field: 'owner', condition: { op: 'not_in', value: [] } },
    ];
    const def = ok(buildShapeDefinition(input({ scope: { rls } as never, tenants: 'all' })));
    expect(def.where).toBe('(false) AND ("owner" IS NOT NULL)');
  });

  it('refuses what it cannot express instead of leaving it out', () => {
    const cases: Array<Partial<ShapeInput['scope']>> = [
      { altersRestrict: true },
      { entityChecks: true },
      { rls: [{ field: 'nope', condition: { op: 'eq', value: 'a' } }] },
      { rls: [{ field: 'title', condition: { op: 'gt' as never, value: 'a' } }] },
    ];
    for (const scope of cases) {
      const def = buildShapeDefinition(input({ scope } as never));
      expect(def.ok ? null : def.code).toBe('electric.unfilterable');
    }
  });
});

describe('shapeSearchParams', () => {
  it('quotes identifiers and numbers the params from 1', () => {
    const def = ok(
      buildShapeDefinition(
        input({
          columns: ['id', 'tenant_id', 'we"ird'],
          scope: { rls: [{ field: 'we"ird', condition: { op: 'eq', value: "o'k" } }] } as never,
        }),
      ),
    );
    expect(shapeSearchParams(def)).toEqual([
      ['table', 'zvd_notes'],
      ['columns', '"id","tenant_id","we""ird"'],
      ['where', '(tenant_id IN ($1)) AND ("we""ird" = $2)'],
      ['params[1]', A],
      ['params[2]', "o'k"],
    ]);
  });
});
