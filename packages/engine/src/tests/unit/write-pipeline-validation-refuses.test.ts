/**
 * write-pipeline.ts — a write is REFUSED when the validation rules cannot be
 * evaluated.
 *
 * `validateRecord` used to be called without a guard, and a throw from it went
 * up as a 500 or, worse, was swallowed further out and the row was written. That
 * inverts the posture at the one place it matters most: these are constraints an
 * administrator deliberately put in place, and failing open means they hold
 * exactly when nothing is wrong and vanish exactly when something is — a
 * transient database error, a malformed `rule_config` that survived JSONB
 * storage, a rule type nobody implemented.
 *
 * The neighbouring regex path already had this right: `safeRegexTest` answers
 * `false` — a non-match, hence a validation error — on both a bad pattern and a
 * ReDoS timeout.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { initValidationEngine } from '../../lib/validation-engine.js';
import { processInput } from '../../lib/data/write-pipeline.js';
import { CannedDb } from './fixtures/canned-db.js';

// Without this, every field is "unknown field type" and the assertions below
// would be about the registry rather than about validation.
registerCoreFieldTypes(fieldTypeRegistry);

const COLLECTION = {
  name: 'wpv_orders',
  fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
};

describe('processInput — validation rules that cannot be evaluated', () => {
  it('refuses the write and says why, rather than letting it through', async () => {
    const db = new CannedDb();
    // Not "no rules" — unreadable rules. The two must not look the same.
    db.fail(/from "zv_validation_rules"/, new Error('connection terminated unexpectedly'));
    db.when(/FROM zvd_validation_rule_groups/, []);
    initValidationEngine(db.kysely as unknown as Database);

    const { errors } = await processInput({ title: 'x' }, COLLECTION as never);

    expect(errors.some((e) => /could not be evaluated, so the write was refused/.test(e))).toBe(
      true,
    );
  });

  it('does not refuse a write when the rules evaluate and pass', async () => {
    // The guard must not turn "this collection has no rules" into a refusal —
    // that is most collections, and it would block every write in the product.
    const db = new CannedDb();
    db.when(/from "zv_validation_rules"/, []);
    db.when(/FROM zvd_validation_rule_groups/, []);
    initValidationEngine(db.kysely as unknown as Database);

    const { errors } = await processInput({ title: 'x' }, {
      ...COLLECTION,
      name: 'wpv_ok',
    } as never);
    expect(errors).toEqual([]);
  });
});
