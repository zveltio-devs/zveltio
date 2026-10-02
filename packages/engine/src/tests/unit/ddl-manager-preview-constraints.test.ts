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
          defaultValue: 'n/a',
        },
      ],
    } as never);
    const joined = stmts.join('\n');
    // Inline, exactly as createCollection writes the column.
    expect(joined).toContain('"sku" text NOT NULL UNIQUE');
    expect(joined).toContain(`"label" text DEFAULT 'n/a'`);
    expect(joined).toContain('idx_zvd_items_label');
    expect(joined).toContain('idx_zvd_items_tenant_id');
  });

  it('rejects invalid collection names', async () => {
    await expect(
      DDLManager.previewCollection({ name: 'Bad-Name', fields: [] } as never),
    ).rejects.toThrow('Invalid collection name');
  });
});
