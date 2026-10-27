import { expect, it } from 'bun:test';
import { FieldSchema } from '../../lib/data/ddl-manager.js';

/** A bad referential action is a 400 at the schema, not an error inside the DDL. */
const field = (options: Record<string, unknown>) =>
  FieldSchema.safeParse({
    name: 'owner',
    type: 'm2o',
    options: { related_collection: 'users', ...options },
  });

it('refuses an on_delete or on_update the FK cannot take', () => {
  for (const options of [{ on_delete: 'DROP TABLE' }, { on_update: 'explode' }]) {
    const r = field(options);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['options', Object.keys(options)[0]!]);
  }
});

it('takes every action the FK can, in any case, and none at all', () => {
  for (const v of ['CASCADE', 'set null', 'Restrict', 'NO ACTION']) {
    expect(field({ on_delete: v, on_update: v }).success).toBe(true);
  }
  expect(field({}).success).toBe(true);
});
