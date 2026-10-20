/**
 * Rolling back 087 must not change what an expression rule means.
 *
 * 087's UP left a rule with a `||` as written — in expr-eval that is string
 * concatenation — and its DOWN spells every `||` back as ` or `. Measured on
 * master: `zveltio rollback --to 86` turned `value || "-x" == "a-x"` into
 * `value  or  "-x" == "a-x"` and reported success. After 087 a `||` it wrote
 * and one it left are the same text, so 090's DOWN refuses while a rule older
 * than 087 holds one, and only for a rollback that reaches 087.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { rollbackMigration, runPending } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = 'mig090_cel_down_guard';

const insertRule = async (db: Database, expression: string): Promise<string> => {
  const r = await sql<{ id: string }>`
    INSERT INTO zv_validation_rules (collection, field_name, rule_type, rule_config, error_message)
    VALUES (${COLLECTION}, 'f', 'custom', jsonb_build_object('expression', ${expression}::text), 'x')
    RETURNING id`.execute(db);
  return r.rows[0].id;
};
const expressions = async (db: Database): Promise<string[]> =>
  (
    await sql<{ e: string }>`
      SELECT rule_config->>'expression' AS e FROM zv_validation_rules
       WHERE collection = ${COLLECTION} ORDER BY created_at, id`.execute(db)
  ).rows.map((r) => r.e);

d('rolling back 087 (validation rules to CEL)', () => {
  it('refuses while a rule older than 087 holds a `||`, and not otherwise', async () => {
    const { db } = await getTestApp();
    try {
      // Rules written for expr-eval, before 087 ran.
      expect((await rollbackMigration(db, 86)).success).toBe(true);
      const concat = await insertRule(db, 'value || "-x" == "a-x"');
      await insertRule(db, 'value > 1 or value < -1');
      await runPending(db);
      expect(await expressions(db)).toEqual(['value || "-x" == "a-x"', 'value > 1 || value < -1']);

      const refused = await rollbackMigration(db, 86);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain(concat);
      expect(await expressions(db)).toEqual(['value || "-x" == "a-x"', 'value > 1 || value < -1']);
      const at87 = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_schema_versions
         WHERE version = 87 AND rolled_back_at IS NULL`.execute(db);
      expect(at87.rows[0].n).toBe(1);

      // A rollback that stops above 087 does not run its DOWN.
      expect(await rollbackMigration(db, 88)).toEqual({ success: true });
      await runPending(db);

      // A rule written after 087 is CEL: its `||` is logical and goes back to `or`.
      await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
      await insertRule(db, 'value > 1 || value < -1');
      expect(await rollbackMigration(db, 86)).toEqual({ success: true });
      expect(await expressions(db)).toEqual(['value > 1  or  value < -1']);
    } finally {
      await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
      // A failure above must not leave the shared database migrations short.
      await runPending(db);
    }
  }, 120_000);
});
