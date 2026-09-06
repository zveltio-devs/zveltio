import { describe, expect, it } from 'bun:test';
import { EXTENSION_TABLE_GRANTS, buildAllowedTables } from '../../lib/extensions/register.js';

/**
 * A grant in `EXTENSION_TABLE_GRANTS` has to reach the allowlist.
 *
 * `granted` was read in exactly one place — the guard that suppresses the
 * warning on a `CREATE TABLE` the extension already wrote — and never added to
 * the returned set. So a granted engine table the extension does not itself
 * CREATE never entered the allowlist, and `createRestrictedDb` refused it:
 * `permitted` is the `zvd_` prefix, or the owned prefix, or
 * `allowedTables.has(...)`, and the grant reached none of the three.
 *
 * Measured over the whole registry before the fix: 5 of 18 entries landed, 13
 * did not — and every one of the five is a table the extension also CREATEs,
 * which is why it worked and why it would have worked without the grant.
 *
 * Nothing could tell the two apart: an extension with no migrations produces an
 * identical allowlist whether its grant is effective or inert, so a suite that
 * mounts extensions sees the same thing either way. That is failure class 13 —
 * a test passing for the wrong reason — approached from the other side.
 */
describe('EXTENSION_TABLE_GRANTS is effective', () => {
  it('puts every granted table in the allowlist, with no migrations at all', async () => {
    // No migration paths on purpose: a grant must stand on its own, which is the
    // entire case the registry exists for. With files present, a table the
    // extension also CREATEs would land regardless and hide the defect.
    for (const [ext, grants] of Object.entries(EXTENSION_TABLE_GRANTS)) {
      const allowed = await buildAllowedTables([], ext);
      const lower = new Set([...allowed].map((t) => t.toLowerCase()));
      for (const table of grants) {
        expect(`${ext}:${table}:${lower.has(table.toLowerCase())}`).toBe(`${ext}:${table}:true`);
      }
    }
  });

  it('grants nothing to an extension that has none', async () => {
    // The other direction: seeding from the registry must not open the set for
    // an extension with no entry.
    const allowed = await buildAllowedTables([], 'no-such-extension');
    expect([...allowed]).toEqual([]);
  });
});
