/**
 * write-pipeline.ts — the error and input shapes the existing unit tests never
 * built, each pinned by a mutation that survived the whole write-pipeline suite.
 *
 * Bun.SQL puts a generic `ERR_POSTGRES_SERVER_ERROR` in `code` and the SQLSTATE
 * in `errno`. Every mapPgError test passed either a bare `errno` or a bare
 * `code`, so reading `code` first, or accepting any `code` as a SQLSTATE, went
 * unnoticed — and in production that turns every 409/422 into an unmapped 500.
 * The message-only fallbacks and the FK `detail` were likewise only reached
 * through messages that matched more than one pattern at once.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import {
  describeWriteRefusal,
  getVirtualConfig,
  isRlsRefusal,
  isUuid,
  mapPgError,
  processInput,
} from '../../lib/data/write-pipeline.js';
import { initValidationEngine } from '../../lib/validation-engine.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

const BUN = 'ERR_POSTGRES_SERVER_ERROR';

describe('mapPgError — Bun.SQL error shape', () => {
  it('reads the SQLSTATE from errno when code holds Bun’s generic marker', () => {
    const mapped = mapPgError({ code: BUN, errno: '23505', message: 'boom' });
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.code).toBe('23505');
  });

  it('does not report Bun’s marker as the SQLSTATE', () => {
    const mapped = mapPgError({
      code: BUN,
      message: 'duplicate key value violates unique constraint "t_pkey"',
    });
    expect(mapped?.body.code).toBe('23505');
  });

  it('42703 reports its own code', () => {
    expect(mapPgError({ code: BUN, errno: '42703', message: 'x' })?.body.code).toBe('42703');
  });
});

describe('mapPgError — each message fallback on its own', () => {
  const cases: [string, number, string][] = [
    ['duplicate key value', 409, 'unique_violation'],
    ['could not create unique constraint', 409, 'unique_violation'],
    ['not-null constraint failed', 422, 'not_null_violation'],
    ['value violates not-null', 422, 'not_null_violation'],
    ['invalid input syntax for type uuid: "abc"', 422, 'invalid_value'],
  ];
  for (const [message, status, error] of cases) {
    it(`"${message}" → ${status} ${error}`, () => {
      const mapped = mapPgError({ code: BUN, message });
      expect(mapped?.status as number).toBe(status);
      expect(mapped?.body.error).toBe(error);
    });
  }
});

describe('mapPgError — foreign key named in detail', () => {
  it('a delete blocked by a referencing row names that collection, not a field', () => {
    const mapped = mapPgError({
      code: BUN,
      errno: '23503',
      message:
        'update or delete on table "zvd_authors" violates foreign key constraint "fk" on table "zvd_books"',
      detail: 'Key (id)=(7) is still referenced from table "zvd_books".',
    });
    expect(mapped?.status).toBe(422);
    expect(mapped?.body.message).toBe(
      'This record is still referenced by "books" and cannot be deleted.',
    );
    expect(mapped?.body.field).toBeNull();
  });
});

describe('RLS refusal helpers', () => {
  it('isRlsRefusal reads errno under Bun’s marker, and the message alone', () => {
    expect(isRlsRefusal({ code: BUN, errno: '42501', message: 'x' })).toBe(true);
    expect(
      isRlsRefusal({ message: 'new row violates row-level security policy for table "zvd_x"' }),
    ).toBe(true);
    expect(isRlsRefusal({ code: BUN, errno: '23505', message: 'x' })).toBe(false);
  });

  it('describeWriteRefusal names the table Postgres named', () => {
    expect(
      describeWriteRefusal('new row violates row-level security policy for table "zvd_orders"'),
    ).toContain('refused this row on zvd_orders.');
  });
});

describe('isUuid', () => {
  it('refuses a UUID with anything around it', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(isUuid(id)).toBe(true);
    expect(isUuid(`x${id}`)).toBe(false);
    expect(isUuid(`${id}x`)).toBe(false);
  });
});

describe('getVirtualConfig', () => {
  it('ignores a virtual_config on a collection that is not virtual', async () => {
    DDLManager.invalidateCache();
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'wprs_table', source_type: 'table', virtual_config: { source_url: 'https://x' } },
    ]);
    expect(await getVirtualConfig(db.kysely as unknown as Database, 'wprs_table')).toBeNull();
  });
});

describe('processInput', () => {
  // The validation handle is module state: leave none behind for the next file.
  afterAll(() => initValidationEngine(null as unknown as Database));

  const rulesDb = (rules: unknown[]) => {
    const db = new CannedDb();
    db.when(/from "zv_validation_rules"/, rules);
    db.when(/FROM zvd_validation_rule_groups/, []);
    initValidationEngine(db.kysely as unknown as Database);
  };

  it('a PATCH that does not send a required field of an unknown type is not refused', async () => {
    rulesDb([]);
    const def = {
      name: 'wprs_unknown',
      fields: [{ name: 'ghost', type: 'not_a_registered_type', required: true }],
    };
    const { errors } = await processInput({}, def as never, true);
    expect(errors).toEqual([]);
  });

  it('a virtual field’s value is not written', async () => {
    rulesDb([]);
    const def = {
      name: 'wprs_virtual',
      fields: [
        { name: 'title', type: 'text', required: false },
        { name: 'calc', type: 'computed', required: false },
      ],
    };
    const { errors, processed } = await processInput({ title: 'a', calc: 'x' }, def as never);
    expect(errors).toEqual([]);
    expect(processed).toEqual({ title: 'a' });
  });

  it('an administrator rule that fails refuses the write with its message', async () => {
    rulesDb([
      {
        id: 'r1',
        field_name: 'title',
        rule_type: 'minLength',
        rule_config: { value: 5 },
        error_message: 'title too short',
      },
    ]);
    const def = { name: 'wprs_rules', fields: [{ name: 'title', type: 'text', required: false }] };
    const { errors } = await processInput({ title: 'ab' }, def as never);
    expect(errors).toEqual(['title: title too short']);
  });
});

describe('mapPgError — no column known', () => {
  // `column` is built with String(...), so `?? null` never fired and the body
  // said `field: ""` — a field name no collection has.
  it('field is null, not an empty string', () => {
    expect(mapPgError({ code: BUN, errno: '23502', message: 'x' })?.body.field).toBeNull();
    expect(mapPgError({ code: BUN, errno: '23503', message: 'x' })?.body.field).toBeNull();
  });
});
