/**
 * DDLManager.previewCollection — unique + indexed constraints (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';

registerCoreFieldTypes(fieldTypeRegistry);

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.previewCollection — constraints', () => {
  it('includes UNIQUE and indexed column DDL in preview', async () => {
    const { sql: stmts } = await DDLManager.previewCollection({
      name: 'items',
      fields: [
        {
          name: 'sku',
          type: 'text',
          required: true,
          unique: true,
          indexed: false,
        },
        {
          name: 'label',
          type: 'text',
          required: false,
          unique: false,
          indexed: true,
        },
      ],
    } as never);
    const joined = stmts.join('\n');
    expect(joined).toContain('uq_zvd_items_sku');
    expect(joined).toContain('idx_zvd_items_label');
    expect(joined).toContain('idx_zvd_items_tenant_id');
  });

  it('rejects invalid collection names', async () => {
    await expect(
      DDLManager.previewCollection({ name: 'Bad-Name', fields: [] } as never),
    ).rejects.toThrow('Invalid collection name');
  });
});
