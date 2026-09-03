/**
 * Binding a JavaScript value to a `jsonb` column.
 *
 * There is one correct form and three plausible wrong ones. All four were
 * measured against this driver, on a real `jsonb` column:
 *
 *   JSON.stringify(v)                   → a jsonb STRING. `jsonb_typeof` says
 *                                         `string`, `col->>'k'` is NULL and
 *                                         `col ? 'k'` is false.
 *
 *   the raw value                       → correct for an object, WRONG for an
 *                                         array: the driver renders a JS array
 *                                         as a Postgres array literal, so
 *                                         `[{a:1}]` lands as the string
 *                                         `{"[object Object]"}`.
 *
 *   JSON.stringify(v) + `::jsonb`       → still a jsonb STRING. The obvious
 *                                         repair and a trap: the driver has
 *                                         already encoded the parameter as JSON,
 *                                         so the cast turns a jsonb string into
 *                                         a jsonb string.
 *
 *   JSON.stringify(v) + `::text::jsonb` → correct, and correct for EVERY type —
 *                                         object, array, string, number, boolean
 *                                         and null. `::text` forces the parameter
 *                                         to be read as text first, and the
 *                                         second cast parses it.
 *
 * ── Why this lives in the SDK ─────────────────────────────────────
 *
 * Because it had already been written twice. The engine has `lib/jsonb.ts`, and
 * `content/pages` wrote its own after the defect surfaced there in the way that
 * hurts: a popup's `targets` were appended with `jsonb ||`, and the result was
 * an ARRAY CONTAINING THE OLD TEXT, because the old value was text. Seventeen
 * more extensions were writing the same shape with no helper at all.
 *
 * A third copy per extension would be the repository's own dominant bug shape —
 * one rule, written out again somewhere else with a piece missing — so it goes
 * where both sides already compile against: `@zveltio/sdk/extension`.
 *
 * ── Why the defect is invisible until it is not ───────────────────
 *
 * Every reader in both repositories carries `typeof x === 'string' ?
 * JSON.parse(x) : x`, so a string-scalar column reads back correctly and the
 * bug hides. It surfaces the moment SQL treats the column as structured — a
 * `->>`, an index, a `||`, a `jsonb_array_elements`. Two of those have already
 * happened: the `content/pages` popup above, and the engine's flow scheduler,
 * which read `trigger_config.interval_seconds` off a string and therefore ran
 * every cron flow at the default interval instead of its configured one.
 *
 * `scripts/check-jsonb-binding.ts` in the engine repository is the ratchet.
 */

import { sql } from 'kysely';

/**
 * A value ready to be assigned to a `jsonb` column.
 *
 * Works in `.values()`, in `.set()` and in a `doUpdateSet()` branch — all three
 * are writers of the same column and all three have been wrong at some point.
 *
 *   await db.insertInto('zv_forms').values({ fields: toJsonb(fields) }).execute();
 */
export function toJsonb(value: unknown) {
  return sql`${JSON.stringify(value ?? null)}::text::jsonb`;
}
