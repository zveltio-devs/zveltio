/**
 * DDLManager.previewCollection — virtual field types omitted from SQL (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';

registerCoreFieldTypes(fieldTypeRegistry);

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.previewCollection — virtual fields', () => {
  it('omits virtual field types from CREATE TABLE preview', async () => {
    const { sql: stmts } = await DDLManager.previewCollection({
      name: 'mixed',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'rollup', type: 'computed', required: false, unique: false, indexed: false },
      ],
    } as never);
    const joined = stmts.join('\n');
    expect(joined).toContain('"title"');
    expect(joined).not.toContain('"rollup"');
  });
});
