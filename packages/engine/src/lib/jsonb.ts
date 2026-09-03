import { sql } from 'kysely';

/**
 * Bind a JavaScript value to a `jsonb` column so it arrives as the JSON value it
 * is, rather than as a JSON string containing it.
 *
 * There is one correct form and three plausible wrong ones. All four were
 * measured against this driver, on a real `jsonb` column:
 *
 *   JSON.stringify(v)              → jsonb STRING. `jsonb_typeof` says `string`,
 *                                    `v->>'field'` is NULL and `v ? 'field'` is
 *                                    false. This is the shape that has been
 *                                    written to four columns.
 *
 *   the raw value                  → correct for an object, WRONG for an array:
 *                                    the driver renders a JS array as a Postgres
 *                                    array literal, so `[{a:1}]` was stored as
 *                                    the string `{"[object Object]"}`.
 *
 *   JSON.stringify(v) + `::jsonb`  → still a jsonb STRING. The obvious repair
 *                                    and a trap: the driver has already encoded
 *                                    the parameter as JSON, so the cast turns a
 *                                    jsonb string into a jsonb string.
 *
 *   JSON.stringify(v) + `::text::jsonb` → correct, and correct for EVERY type —
 *                                    object, array, string, number, boolean and
 *                                    null. `::text` forces the parameter to be
 *                                    read as text first, and the second cast
 *                                    parses it.
 *
 * The "pass the raw object" advice that fixed `zv_revisions` is right only
 * because those columns always hold objects. Reaching for it on an array-valued
 * column corrupts the row, which is why this helper exists instead of a rule
 * people have to remember per column.
 *
 * Works in `.values()` and in `.set()`.
 */
export function toJsonb(value: unknown) {
  return sql`${JSON.stringify(value ?? null)}::text::jsonb`;
}
