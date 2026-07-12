/**
 * DDLManager.previewCollection — virtual/computed field omission (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';

registerCoreFieldTypes(fieldTypeRegistry);

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.previewCollection — virtual fields', () => {
  it('omits computed columns from CREATE TABLE but keeps real fields', async () => {
    const { sql: stmts } = await DDLManager.previewCollection({
      name: 'ledger',
      fields: [
        { name: 'amount', type: 'number', required: true, unique: false, indexed: false },
        { name: 'total', type: 'computed', required: false, unique: false, indexed: false },
      ],
    } as never);
    const create = stmts.find((s) => s.includes('CREATE TABLE'));
    expect(create).toBeDefined();
    expect(create!).toContain('"amount"');
    expect(create!).not.toContain('"total"');
  });
});
