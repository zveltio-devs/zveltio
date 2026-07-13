/**
 * createRestrictedDb — slash-normalized owned zv_<ext>_ namespace.
 */

import { describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';

describe('createRestrictedDb — owned namespace', () => {
  it('allows access to the extension own zv_ tables when the name has slashes', () => {
    const calls: string[] = [];
    const db = {
      selectFrom(table: string) {
        calls.push(table);
        return db;
      },
    };
    const rdb = createRestrictedDb(db as never, 'compliance/ro/saft');
    rdb.selectFrom('zv_compliance_ro_saft_exports' as never);
    expect(calls).toEqual(['zv_compliance_ro_saft_exports']);
  });

  it('resolves the backing database through a resolver function on each access', () => {
    let resolveCount = 0;
    const dbA = { tag: 'a', selectFrom: () => dbA };
    const dbB = { tag: 'b', selectFrom: () => dbB };
    const rdb = createRestrictedDb(() => {
      resolveCount++;
      return (resolveCount % 2 === 1 ? dbA : dbB) as never;
    }, 'ext-resolver');
    expect((rdb.selectFrom('zvd_items' as never) as unknown as { tag: string }).tag).toBe('a');
    expect((rdb.selectFrom('zvd_items' as never) as unknown as { tag: string }).tag).toBe('b');
    expect(resolveCount).toBeGreaterThanOrEqual(2);
  });
});
