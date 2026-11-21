/**
 * write-pipeline context + virtual config helpers (lib/data/write-pipeline.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, decryptField, fieldTypeRegistry } from '../../lib/data/index.js';
import {
  getDb,
  getTenantId,
  getVirtualConfig,
  processInput,
} from '../../lib/data/write-pipeline.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = savedKey;
});

const TENANT = '7a1d2c3b-0000-4000-8000-000000000042';
const RECORD = '5f0c8a52-6a1e-4f0e-9a43-1f0b2c3d4e5f';
/** Answers `writeTenant`'s query as the write's transaction would. */
const tenantDb = () => new CannedDb().when(/current_setting/, [{ t: TENANT }]);

function mockContext(over: Record<string, unknown> = {}): Context {
  const bag = new Map<string, unknown>(Object.entries(over));
  return {
    get: (k: string) => bag.get(k),
  } as unknown as Context;
}

describe('getDb / getTenantId', () => {
  it('prefers tenantTrx over the pool fallback', () => {
    const trx = { isTransaction: true } as unknown as Database;
    const pool = new CannedDb().kysely as unknown as Database;
    const c = mockContext({ tenantTrx: trx });
    expect(getDb(c, pool)).toBe(trx);
    expect(getTenantId(c)).toBeNull();
  });

  it('reads tenant id from the request bag', () => {
    const c = mockContext({ tenant: { id: 'tenant-42' } });
    expect(getTenantId(c)).toBe('tenant-42');
  });
});

describe('getVirtualConfig', () => {
  it('parses string virtual_config for virtual collections', async () => {
    DDLManager.invalidateCache();
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'external_api',
        source_type: 'virtual',
        virtual_config: JSON.stringify({
          source_url: 'https://api.example.com',
          auth_type: 'none',
          field_mapping: {},
          list_path: '$.items',
          id_field: 'id',
        }),
      },
    ]);
    const cfg = await getVirtualConfig(db.kysely as unknown as Database, 'external_api');
    expect(cfg?.source_url).toBe('https://api.example.com');
    expect(cfg?.auth_type).toBe('none');
  });

  it('returns null for non-virtual collections', async () => {
    DDLManager.invalidateCache();
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'contacts', source_type: 'table', virtual_config: null },
    ]);
    expect(await getVirtualConfig(db.kysely as unknown as Database, 'contacts')).toBeNull();
  });
});

describe('processInput validation + encryption', () => {
  it('collects field validation errors on create', async () => {
    const { errors, processed } = await processInput(
      {},
      {
        name: 'products',
        fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
      } as never,
      false,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(processed).toEqual({});
  });

  it('encrypts flagged fields via maybeEncrypt', async () => {
    const { errors, processed } = await processInput(
      { secret: 'plain-token' },
      {
        name: 'vault',
        fields: [
          {
            name: 'secret',
            type: 'text',
            required: true,
            unique: false,
            indexed: false,
            encrypted: true,
          },
        ],
      } as never,
      false,
      null,
      undefined,
      false,
      { db: tenantDb().kysely as unknown as Database, record: RECORD },
    );
    expect(errors).toEqual([]);
    expect(String(processed.secret)).toMatch(/^enc:v2:/);
    // Sealed to the tenant the row gets, the collection, the field and the id.
    expect(
      await decryptField(String(processed.secret), {
        tenant: TENANT,
        collection: 'vault',
        field: 'secret',
        record: RECORD,
      }),
    ).toBe('plain-token');
  });

  it('refuses an encrypted value on a path that names no record to seal it to', async () => {
    const { errors, processed } = await processInput(
      { secret: 'plain-token' },
      {
        name: 'vault',
        fields: [{ name: 'secret', type: 'text', encrypted: true }],
      } as never,
      false,
    );
    expect(errors.join()).toMatch(/sealed to its record/);
    expect(processed.secret).toBeUndefined();
  });
});
