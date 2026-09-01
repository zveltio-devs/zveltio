/**
 * The generated predicate has to MEAN what `getRlsFilters` means.
 *
 * A second enforcement that disagrees with the first is not a second line of
 * defence, it is a second source of truth — and two sources that disagree are
 * worse than one. So these pin the parts that are easy to get subtly wrong,
 * each one transcribed from the engine's own behaviour rather than invented.
 */

import { describe, expect, it } from 'bun:test';
import { buildRowRulePredicate, type RowRule } from '../../lib/tenancy/row-rule-policy.js';

const TYPES = { created_by: 'text', code: 'integer', bucket: 'text', payload: 'jsonb' };
const rule = (over: Partial<RowRule> = {}): RowRule => ({
  role: '*',
  filter_field: 'created_by',
  filter_op: 'eq',
  filter_value_source: 'user_id',
  ...over,
});

describe('row rules as a Postgres predicate', () => {
  it('produces nothing when there are no rules', () => {
    expect(buildRowRulePredicate([], TYPES).predicate).toBeNull();
  });

  it('reads the caller from a setting, not from a role name', () => {
    const { predicate } = buildRowRulePredicate([rule()], TYPES);
    expect(predicate).toContain("current_setting('zveltio.user_id', true)");
    expect(predicate).toContain('"created_by" =');
  });

  it('lets an exempt session through', () => {
    // The engine decides the exemption — an API key with rlsBypass, or the
    // `data:view_all` permission a god holds — and publishes it. Comparing a
    // role name here would be the unauditable check that sat dead in
    // `getRlsFilters` for years.
    const { predicate } = buildRowRulePredicate([rule()], TYPES);
    expect(predicate).toContain('zveltio.rls_bypass');
    expect(predicate).not.toContain("'god'");
  });

  it('uses <> for neq on the COLUMN, not IS DISTINCT FROM', () => {
    // On a NULL column the engine's `!=` drops the row. `IS DISTINCT FROM`
    // would keep it, and the two enforcements would disagree about a NULL.
    //
    // Asserted against the column comparison specifically. The whole-predicate
    // spelling used to be `not.toContain('IS DISTINCT FROM')`, which also
    // forbade it anywhere else — and the actor guard legitimately uses it, on a
    // setting rather than on a row. A test that pins a substring of the output
    // pins more than it means to.
    const { predicate } = buildRowRulePredicate([rule({ filter_op: 'neq' })], TYPES);
    expect(predicate).toContain('"created_by" <>');
    expect(predicate).not.toContain('"created_by" IS DISTINCT FROM');
  });

  it('stands down where there is no actor, not merely where a value is empty', () => {
    // This used to assert the opposite, and the reversal is the point.
    //
    // The guard was `nullif(current_setting('zveltio.user_id'), '') IS NULL` —
    // skip on any EMPTY setting. But `getRlsFilters` skips only where
    // `resolveValue` returns null, and that is per source: `user_id` and
    // `user_role` return the value even when it is the empty string, while
    // `user_email` returns null when there is no email.
    //
    // So `bucket eq user_role` against a session whose role is unset — every
    // session, since better-auth does not populate it — had the engine hiding
    // every row and the policy showing all of them. The policy was the more
    // permissive of the two, on the layer that exists for the handler that
    // forgot its filters.
    //
    // `zveltio.actor` is a setting of its own because absence cannot be
    // detected: after one SET LOCAL and COMMIT a custom GUC survives as '', so
    // `IS NULL` means "first request on a fresh pooled connection".
    const { predicate } = buildRowRulePredicate([rule()], TYPES);
    expect(predicate).toContain("current_setting('zveltio.actor', true) IS DISTINCT FROM 'on'");
    expect(predicate).not.toContain("nullif(current_setting('zveltio.user_id', true), '')");
  });

  it('still treats an absent email as unresolved, because the engine does', () => {
    // The one source where empty genuinely means "cannot resolve":
    // `resolveValue` returns `user.email ?? null`, so a caller with no email
    // skips the rule. An API key is the case that matters.
    const { predicate } = buildRowRulePredicate(
      [rule({ filter_value_source: 'user_email' })],
      TYPES,
    );
    expect(predicate).toContain("nullif(current_setting('zveltio.user_email', true), '') IS NULL");
  });

  it("does not apply a rule the caller's roles do not match", () => {
    const { predicate } = buildRowRulePredicate([rule({ role: 'editor' })], TYPES);
    expect(predicate).toContain('zveltio.user_roles');
    expect(predicate).toContain("'editor'");
  });

  it('applies a `*` rule to everyone, with no role guard', () => {
    const { predicate } = buildRowRulePredicate([rule({ role: '*' })], TYPES);
    expect(predicate).not.toContain('user_roles');
  });

  describe('lists', () => {
    it('splits a static value on commas for in', () => {
      const { predicate } = buildRowRulePredicate(
        [rule({ filter_field: 'bucket', filter_op: 'in', filter_value_source: 'static:a, b ,c' })],
        TYPES,
      );
      expect(predicate).toContain(`"bucket" IN ('a', 'b', 'c')`);
    });

    it('does NOT split a user_id value, because it is a scalar', () => {
      // Only `static:` can express a list. A one-element list means the same as
      // `eq`, which is exactly what the engine does.
      const { predicate } = buildRowRulePredicate(
        [rule({ filter_op: 'in', filter_value_source: 'user_id' })],
        TYPES,
      );
      expect(predicate).toContain(`"created_by" IN (current_setting('zveltio.user_id', true))`);
    });

    it('refuses an empty static list rather than emitting IN ()', () => {
      const { predicate, skipped } = buildRowRulePredicate(
        [rule({ filter_op: 'in', filter_value_source: 'static: , ' })],
        TYPES,
      );
      expect(predicate).toBeNull();
      expect(skipped[0]?.reason).toContain('empty');
    });
  });

  describe('what it refuses, loudly', () => {
    it('casts the setting into the column type, because current_setting is text', () => {
      // `"code" = current_setting(...)` against an integer column is a type
      // error, not a comparison.
      const { predicate } = buildRowRulePredicate(
        [rule({ filter_field: 'code', filter_value_source: 'static:5' })],
        TYPES,
      );
      expect(predicate).toContain("CAST('5' AS integer)");
    });

    it('will not generate for a type it cannot cast into', () => {
      const { predicate, skipped } = buildRowRulePredicate(
        [rule({ filter_field: 'payload' })],
        TYPES,
      );
      expect(predicate).toBeNull();
      expect(skipped[0]?.reason).toContain('jsonb');
    });

    it('will not generate for a column that is not there', () => {
      const { skipped } = buildRowRulePredicate([rule({ filter_field: 'nope' })], TYPES);
      expect(skipped[0]?.reason).toContain('does not exist');
    });

    it('will not generate for an operator it does not know', () => {
      const { skipped } = buildRowRulePredicate([rule({ filter_op: 'gt' })], TYPES);
      expect(skipped[0]?.reason).toContain('not one of');
    });

    it('refuses a field name that is not an identifier', () => {
      const { skipped } = buildRowRulePredicate(
        [rule({ filter_field: 'a"; DROP TABLE x --' })],
        TYPES,
      );
      expect(skipped[0]?.reason).toContain('identifier');
    });

    it('keeps the rules it CAN express when another is skipped', () => {
      // One unexpressible rule must not take the enforceable ones with it.
      const { predicate, skipped } = buildRowRulePredicate(
        [rule(), rule({ filter_field: 'payload' })],
        TYPES,
      );
      expect(predicate).toContain('"created_by"');
      expect(skipped).toHaveLength(1);
    });
  });

  it('combines several rules with AND', () => {
    const { predicate } = buildRowRulePredicate(
      [rule(), rule({ filter_field: 'bucket', filter_value_source: 'static:alpha' })],
      TYPES,
    );
    expect(predicate).toContain(' AND ');
  });

  it('escapes a quote in a static value instead of ending the literal', () => {
    const { predicate } = buildRowRulePredicate(
      [rule({ filter_field: 'bucket', filter_value_source: "static:o'brien" })],
      TYPES,
    );
    expect(predicate).toContain("'o''brien'");
  });
});
