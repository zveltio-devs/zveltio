/**
 * validation-engine.ts — rule GROUPS, and the `uuid[]` the driver hands back.
 *
 * A group says "these rules are alternatives": either a VAT number or a
 * registration number, not both. Two things in that path had never been
 * exercised.
 *
 * `rule_ids` is a `uuid[]` column, and Bun's driver returns a PostgreSQL array
 * as its TEXT LITERAL — `{a,b}`, not `['a','b']`. Code that assumed a native
 * array got a string, `includes()` matched substrings instead of members, and a
 * group either matched every rule or none.
 *
 * And a group whose table cannot be read must not become "no groups", which
 * silently reverts every alternative to all-must-hold — the strict direction,
 * but not the configured one.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { validateRecord } from '../../lib/validation-engine.js';
import { CannedDb } from './fixtures/canned-db.js';

const RULE_A = '00000000-0000-4000-8000-0000000000a1';
const RULE_B = '00000000-0000-4000-8000-0000000000b2';

/** A `pattern` rule: violated unless the value matches. */
function rule(id: string, field: string, pattern: string) {
  return {
    id,
    field_name: field,
    rule_type: 'pattern',
    rule_config: { pattern },
    error_message: `must match ${pattern}`,
  };
}

/**
 * Rules and groups are cached for 60s at module scope, keyed by collection — so
 * every test uses its own collection name rather than fighting the cache.
 */
let n = 0;
function freshCollection(): string {
  n += 1;
  return `orgs_grp_${n}`;
}

function dbWith(groupRows: unknown[], ruleRows: unknown[]): CannedDb {
  const db = new CannedDb();
  db.when(/FROM zvd_validation_rule_groups/, groupRows as never[]);
  db.when(/from "zv_validation_rules"/, ruleRows as never[]);
  return db;
}

describe('validateRecord — rule groups', () => {
  it('reads rule_ids delivered as a PostgreSQL array literal, not a JS array', async () => {
    const c = freshCollection();
    // `{a,b}` — what the driver actually hands over for a uuid[] column.
    const db = dbWith(
      [{ field_name: 'code', logic: 'OR', rule_ids: `{${RULE_A},${RULE_B}}` }],
      [rule(RULE_A, 'code', '^VAT'), rule(RULE_B, 'code', '^REG')],
    );

    // Satisfying ONE member satisfies the group. Mis-parse the literal and the
    // group holds no members, both rules apply on their own, and 'VAT-1' fails
    // the second one.
    const ok = await validateRecord(db.kysely as unknown as Database, c, { code: 'VAT-1' });
    expect(ok.valid).toBe(true);
  });

  it('still fails when no member of an OR group holds', async () => {
    const c = freshCollection();
    const db = dbWith(
      [{ field_name: 'code', logic: 'OR', rule_ids: `{${RULE_A},${RULE_B}}` }],
      [rule(RULE_A, 'code', '^VAT'), rule(RULE_B, 'code', '^REG')],
    );
    const bad = await validateRecord(db.kysely as unknown as Database, c, { code: 'NEITHER' });
    expect(bad.valid).toBe(false);
    expect(bad.errors.code?.length).toBeGreaterThan(0);
  });

  it('accepts a native array too, since the shape depends on the driver', async () => {
    const c = freshCollection();
    const db = dbWith(
      [{ field_name: 'code', logic: 'OR', rule_ids: [RULE_A, RULE_B] }],
      [rule(RULE_A, 'code', '^VAT'), rule(RULE_B, 'code', '^REG')],
    );
    const r = await validateRecord(db.kysely as unknown as Database, c, { code: 'REG-9' });
    expect(r.valid).toBe(true);
  });

  it('treats an absent groups table as "no groups", which is every rule on its own', async () => {
    // The validation-rules extension is not installed on most instances, so the
    // table genuinely is not there. That is a state, not a failure — and without
    // groups an ungrouped rule must still be enforced.
    const c = freshCollection();
    const db = new CannedDb();
    db.fail(/FROM zvd_validation_rule_groups/, new Error('relation does not exist'));
    db.when(/from "zv_validation_rules"/, [rule(RULE_A, 'code', '^VAT')] as never[]);
    expect(
      (await validateRecord(db.kysely as unknown as Database, c, { code: 'VAT-1' })).valid,
    ).toBe(true);

    const c2 = freshCollection();
    const db2 = new CannedDb();
    db2.fail(/FROM zvd_validation_rule_groups/, new Error('relation does not exist'));
    db2.when(/from "zv_validation_rules"/, [rule(RULE_A, 'code', '^VAT')] as never[]);
    expect(
      (await validateRecord(db2.kysely as unknown as Database, c2, { code: 'nope' })).valid,
    ).toBe(false);
  });
  it('an AND group still requires every member, which is the default logic', async () => {
    // `logic` is anything other than 'OR'. The group exists to say "these belong
    // together"; only OR changes what satisfying it means. Getting this branch
    // wrong would quietly turn every AND group into an OR — the permissive
    // direction, on rules an administrator wrote to be strict.
    const c = freshCollection();
    const db = dbWith(
      [{ field_name: 'code', logic: 'AND', rule_ids: `{${RULE_A},${RULE_B}}` }],
      [rule(RULE_A, 'code', '^VAT'), rule(RULE_B, 'code', '-1$')],
    );

    // Satisfies the first member only.
    const partial = await validateRecord(db.kysely as unknown as Database, c, { code: 'VAT-9' });
    expect(partial.valid).toBe(false);

    const c2 = freshCollection();
    const db2 = dbWith(
      [{ field_name: 'code', logic: 'AND', rule_ids: `{${RULE_A},${RULE_B}}` }],
      [rule(RULE_A, 'code', '^VAT'), rule(RULE_B, 'code', '-1$')],
    );
    // Satisfies both.
    const both = await validateRecord(db2.kysely as unknown as Database, c2, { code: 'VAT-1' });
    expect(both.valid).toBe(true);
  });
});
