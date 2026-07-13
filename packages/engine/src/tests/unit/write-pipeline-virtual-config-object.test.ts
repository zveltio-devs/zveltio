/**
 * write-pipeline.ts — getVirtualConfig accepts object virtual_config.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getVirtualConfig } from '../../lib/data/write-pipeline.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('getVirtualConfig — object config', () => {
  it('returns parsed config when virtual_config is already an object', async () => {
    DDLManager.invalidateCache();
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'obj_virtual',
        source_type: 'virtual',
        virtual_config: {
          source_url: 'https://api.example.com/v2',
          auth_type: 'bearer',
          field_mapping: { title: 'name' },
          list_path: '$.data',
          id_field: 'uuid',
        },
      },
    ]);
    const cfg = await getVirtualConfig(db.kysely as unknown as Database, 'obj_virtual');
    expect(cfg?.source_url).toBe('https://api.example.com/v2');
    expect(cfg?.auth_type).toBe('bearer');
    expect(cfg?.field_mapping).toEqual({ title: 'name' });
  });
});
