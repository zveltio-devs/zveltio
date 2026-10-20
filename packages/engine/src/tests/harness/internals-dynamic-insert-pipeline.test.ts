/**
 * `ctx.internals.dynamicInsert` runs the field pipeline, like every other
 * extension write.
 *
 * It was the raw `db/dynamic.ts` helper: no type validation, no
 * deserialization, no field encryption, no administrator validation rules.
 * Its caller, the import extension, re-implemented deserialize + encrypt by
 * hand and nothing else, so a CSV import stored rows that the data API, and
 * `ctx.db.insertInto` from the same extension, refuse.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import type { ExtensionInternals } from '../../lib/extensions/internals.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { DEFAULT_TENANT_ID, withTenantIsolation } from '../../lib/tenancy/index.js';
import { invalidateRulesCache } from '../../lib/validation-engine.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hintins_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('ctx.internals.dynamicInsert runs the field pipeline', () => {
  let db: Database;
  let internals: ExtensionInternals;

  // The handle the loader gives an extension's `withTenantIsolation` callback.
  const insert = (row: Record<string, unknown>) =>
    withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
      internals.dynamicInsert(
        createRestrictedDb(trx, 'pipe-ext', new Set([TABLE])) as never,
        TABLE,
        row,
      ),
    );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'status', type: 'text', required: false, unique: false, indexed: false },
        {
          name: 'contact',
          type: 'email',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
    // A `transition` rule judged against `previous = null`: a record starts as draft.
    await sql`
      INSERT INTO zv_validation_rules
        (collection, field_name, rule_type, rule_config, error_message, is_active)
      VALUES (${COLLECTION}, 'status', 'transition',
              ${JSON.stringify({ expression: "previous == null ? value == 'draft' : true" })}::jsonb,
              'A record starts as draft', TRUE)`.execute(db);
    invalidateRulesCache(COLLECTION);
    internals = gateInternals('pipe-ext', buildExtensionInternals(), []);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  it('refuses a row that breaks a validation rule', async () => {
    await expect(insert({ status: 'sent' })).rejects.toThrow(/A record starts as draft/);
  });

  it('refuses a value its field type rejects', async () => {
    await expect(insert({ status: 'draft', contact: 'not-an-email' })).rejects.toThrow(
      /Invalid email/,
    );
  });

  it('stores an encrypted field as ciphertext', async () => {
    const row = (await insert({ status: 'draft', contact: 'a@b.co' })) as { id: string };
    const stored = await sql<{ contact: string }>`
      SELECT contact FROM ${sql.table(TABLE)} WHERE id = ${row.id}`.execute(db);
    expect(stored.rows[0]?.contact).toStartWith('enc:');
  });
});
