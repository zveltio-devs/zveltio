/**
 * Global teardown for every `bun test` run of this package (bunfig.toml preload).
 *
 * Creating a collection writes its default grants. A test that drops its
 * fixture by hand — DROP TABLE plus DELETE FROM zvd_collections, instead of
 * `dropTestCollection` — leaves those grants behind. Measured 2026-10-25: one
 * harness run left 1 015 `zvd_permissions` rows on 236 fixture names, which
 * `check:test-leftovers` did not look for. They pile up run after run, and a
 * Casbin model that loads thousands of dead rules is the lying measurement that
 * gate exists to prevent. So the grants on a fixture name (`_<10+ digits>`, the
 * suffix the harness gives them) whose collection is gone go here, once, after
 * the last file.
 */

import { afterAll, afterEach } from 'bun:test';
import { SQL } from 'bun';

const url = process.env.TEST_DATABASE_URL;

// Bun 1.4 stores `process.env.X = undefined` as the string "undefined", as Node
// does; 1.3 deleted the variable. A test that restored a saved-but-unset value
// that way left "undefined" behind, and code after it read a real setting: the
// schema dev writer exported into `packages/engine/undefined/`. Restore with
// `delete` when the saved value is undefined.
afterEach(() => {
  const left = Object.keys(process.env).filter((k) => process.env[k] === 'undefined');
  if (left.length) {
    for (const k of left) delete process.env[k];
    throw new Error(`test left process.env ${left.join(', ')} = "undefined"; delete it instead`);
  }
});

afterAll(async () => {
  if (!url) return;
  const sql = new SQL(url);
  try {
    // ponytail: a second run in parallel on the same database could lose a
    // grant a test of its own wrote on a non-collection fixture name mid-test.
    await sql`
      DELETE FROM zvd_permissions p
       WHERE p.ptype = 'p' AND p.v2 ~ ${String.raw`_\d{10,}$`}
         AND NOT EXISTS (SELECT 1 FROM zvd_collections c WHERE c.name = p.v2)
    `;
  } catch {
    // No harness schema (a unit run against an empty database): nothing to clear.
  } finally {
    await sql.end();
  }
});
