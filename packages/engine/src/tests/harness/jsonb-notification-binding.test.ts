/**
 * `zv_notifications.metadata` arrives as an object, not as a string containing one.
 *
 * Migration `010_unwrap_double_encoded_jsonb.sql` repaired this column — it
 * records `22 of 22` rows stored as a jsonb STRING — and states the rule the
 * family was fixed under: "The writers are fixed in the same change, through
 * `lib/jsonb.ts`. The order matters: repairing the data first would leave new
 * rows arriving in the old shape."
 *
 * `sendNotification` was missed. It bound
 * `input.metadata ? JSON.stringify(input.metadata) : '{}'`, so the next
 * notification written after the migration put the old shape straight back, and
 * `'{}'` had the same defect — the driver JSON-encodes that string too, so
 * "empty" metadata arrived as the jsonb string `"{}"` rather than as `{}`.
 *
 * This column is the case with no safety net: migration 010 says
 * `zv_notifications.metadata` and `zv_license_audit.details` "have no
 * reader-side compensation at all. They are typed `Record<string, unknown>` over
 * a value that is a string, so a key lookup yields undefined rather than the
 * stored data." Unlike `zv_api_keys.scopes`, nothing downstream was covering it.
 *
 * ── Why this test asserts in SQL ────────────────────────────────────
 *
 * The defect is invisible from JavaScript. Reading the row back and comparing
 * objects passes either way, because whatever went in comes back out. It is only
 * visible to PostgreSQL: `jsonb_typeof`, `?` and `->>` are what tell a stored
 * object from a stored string, and they are what any future authorization or
 * filtering query would use. So the assertions are those three operators.
 *
 * ── And why it must run on BunSqlDialect ────────────────────────────
 *
 * The first attempt at this proof used Kysely's `pg` dialect and reported the
 * OLD writer as CORRECT — `jsonb_typeof` said `object`. node-postgres sends the
 * parameter as text and PostgreSQL parses it, so the bug does not exist there.
 * Bun's SQL driver JSON-encodes the parameter first, which is the whole reason
 * `lib/jsonb.ts` exists and says "measured against this driver". A test on the
 * wrong driver here is a green light wired to nothing, so this one constructs
 * the engine's real dialect explicitly rather than taking whatever a helper
 * hands it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import { sendNotification } from '../../lib/notifications.js';

const URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let db: Kysely<any>;
const USER = '00000000-0000-4000-8000-00000000e01a';

describe.skipIf(!URL)('zv_notifications.metadata is bound as jsonb', () => {
  beforeAll(async () => {
    db = new Kysely({ dialect: new BunSqlDialect({ connectionString: URL! }) });
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              VALUES (${USER}, 'e01', 'e01@example.test', true, now(), now())
              ON CONFLICT (id) DO NOTHING`.execute(db);
    await sql`DELETE FROM zv_notifications WHERE user_id = ${USER}`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_notifications WHERE user_id = ${USER}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${USER}`.execute(db);
    await db.destroy();
  });

  /** The three operators that can tell a stored object from a stored string. */
  async function shapeOf(title: string) {
    const r = await sql<{ t: string; kp: boolean; ex: string | null }>`
      SELECT jsonb_typeof(metadata) AS t,
             (metadata ? 'k')       AS kp,
             metadata->>'k'         AS ex
      FROM zv_notifications WHERE user_id = ${USER} AND title = ${title}`.execute(db);
    return r.rows[0]!;
  }

  it('stores metadata as an object a SQL query can reach into', async () => {
    await sendNotification(db, {
      user_id: USER,
      title: 'with-metadata',
      message: 'm',
      metadata: { k: 'v' },
    });
    const row = await shapeOf('with-metadata');
    expect(row.t).toBe('object');
    expect(row.kp).toBe(true);
    expect(row.ex).toBe('v');
  });

  it('stores absent metadata as an empty object, not as the string "{}"', async () => {
    await sendNotification(db, { user_id: USER, title: 'no-metadata', message: 'm' });
    const row = await shapeOf('no-metadata');
    expect(row.t).toBe('object');
    expect(row.kp).toBe(false);
  });

  it('the shape the writer used to produce is the one PostgreSQL cannot read', async () => {
    // The old binding, written out verbatim, to pin WHY this matters rather than
    // just that it works now. If this ever starts reporting `object`, the driver
    // has changed and `lib/jsonb.ts`'s premise needs re-measuring — which is a
    // more useful thing to learn from a failure than "the fix regressed".
    await db
      .insertInto('zv_notifications')
      .values({
        user_id: USER,
        title: 'old-shape',
        message: 'm',
        type: 'info',
        metadata: JSON.stringify({ k: 'v' }),
        is_read: false,
        created_at: new Date(),
      })
      .execute();
    const row = await shapeOf('old-shape');
    expect(row.t).toBe('string');
    expect(row.kp).toBe(false);
    expect(row.ex).toBeNull();
  });
});
