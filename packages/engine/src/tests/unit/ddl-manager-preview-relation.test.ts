/**
 * DDLManager.previewCollection — relation FK columns + indexes (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';

registerCoreFieldTypes(fieldTypeRegistry);

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.previewCollection — relations', () => {
  it('includes FK columns and relation indexes in the preview SQL', async () => {
    const { sql: stmts } = await DDLManager.previewCollection({
      name: 'orders',
      fields: [
        {
          name: 'customer',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: 'customers', on_delete: 'cascade' },
        },
        {
          name: 'note',
          type: 'text',
          required: false,
          unique: false,
          indexed: true,
        },
      ],
    } as never);
    const joined = stmts.join('\n');
    expect(joined).toContain('REFERENCES "zvd_customers"(id) ON DELETE CASCADE');
    expect(joined).toContain('idx_zvd_orders_customer');
    expect(joined).toContain('idx_zvd_orders_note');
  });
});
