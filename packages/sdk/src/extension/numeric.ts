/**
 * Turning what PostgreSQL sends into what JavaScript can add.
 *
 * `BIGINT`, `NUMERIC`, `DECIMAL` and every `COUNT`/`SUM`/`AVG` aggregate arrive
 * from the driver as **strings** — Bun's `SQL` exposes no type-parser hook, so
 * there is no place to fix this once for the whole process. That leaves the call
 * site, and the call site is where it goes wrong:
 *
 *     total + row.amount        // "0" + "12.50" → "012.50"
 *     ("012.50") - 1            // NaN
 *
 * Only `+` misbehaves; `-`, `*`, `/`, `<` and `>` coerce and give correct
 * answers. So the failure hides until a sum happens to enter the chain, and then
 * it does not throw — it produces `NaN`, PostgreSQL accepts `NaN` into a
 * `NUMERIC` column, and `NaN` compares as LARGER than every number. A row poisoned
 * this way passes `WHERE balance > 0`, passes `HAVING total >= required`, and
 * passes a `CHECK (col >= 0)` constraint. The database agrees with the corruption.
 *
 * Hence two rules, both enforced here rather than remembered:
 *
 *   * `toNumber` REFUSES `NaN` and `Infinity`. Not "returns 0" — refuses. A value
 *     that reached this point non-finite is already the product of a bug, and
 *     substituting a plausible number buries it one layer deeper.
 *   * `sumNumeric` exists so the common case — adding a column across rows — has
 *     an obvious right answer that is shorter to write than the wrong one.
 *
 * This lives in the SDK, not the engine, on purpose. The safe helper existing
 * somewhere an extension cannot import it is a shape this codebase has produced
 * four times already — `safeFetch`, `maybeDecrypt`, `requireInstanceAdmin` and
 * the validation evaluator all had an engine-side implementation and an
 * extension-side reimplementation that was subtly worse. Every module that
 * handles money is an extension, so the conversion belongs where they can reach
 * it: `import { toNumber } from '@zveltio/sdk/extension'`.
 *
 * The engine keeps its own copy at `lib/numeric.ts` rather than importing this
 * one, because the engine's production code has never taken a RUNTIME dependency
 * on the SDK — only types — and a pure sixty-line converter is not the thing to
 * change that for. `numeric-parity.test.ts` runs both against the same table of
 * inputs so the twins cannot drift apart quietly.
 *
 * @see `PgNumeric` in the engine's `db/schema.ts` for the type side of the same problem.
 */

/** Thrown instead of quietly producing a number nobody can trace. */
export class NumericConversionError extends Error {
  constructor(
    readonly value: unknown,
    label?: string,
  ) {
    super(
      `${label ? `${label}: ` : ''}expected a finite number, got ${
        typeof value === 'string' ? JSON.stringify(value) : String(value)
      }`,
    );
    this.name = 'NumericConversionError';
  }
}

/**
 * A database numeric as a JS number, or a throw.
 *
 * Accepts what the driver actually produces: a string, a number that survived
 * because the column was `INTEGER`, a `bigint`, or `null`/`undefined` for a
 * nullable column. Everything else, and anything non-finite, is an error.
 *
 * `null` and `undefined` map to `fallback`, which defaults to `0`. That is the
 * one substitution worth making: "no row" and "no value" genuinely do mean zero
 * in an aggregate, and the alternative is a `?? 0` at every call site, which is
 * the shape that lets a real `NaN` through.
 */
export function toNumber(value: unknown, fallback = 0, label?: string): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') {
    // Above 2^53 a bigint cannot round-trip through a double. Refusing beats
    // returning a number that is quietly off by a few.
    if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
      throw new NumericConversionError(value, label);
    }
    return Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NumericConversionError(value, label);
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // `Number('')` is 0 and `Number(' ')` is 0 — both of which would turn a
    // malformed column into a confident zero.
    if (trimmed === '') throw new NumericConversionError(value, label);
    const n = Number(trimmed);
    if (!Number.isFinite(n)) throw new NumericConversionError(value, label);
    return n;
  }
  throw new NumericConversionError(value, label);
}

/**
 * `toNumber` for a value that is allowed to be absent, with no substitution.
 *
 * Use it where zero and "not set" mean different things — a quota that has not
 * been configured is not a quota of zero.
 */
export function toNumberOrNull(value: unknown, label?: string): number | null {
  if (value === null || value === undefined) return null;
  return toNumber(value, 0, label);
}

/**
 * `toNumber` that answers `fallback` instead of throwing.
 *
 * For display paths only — a dashboard tile should not 500 because one row is
 * bad. Never use it on a value about to be written back to the database, which
 * is exactly how the poison spreads.
 */
export function toNumberSafe(value: unknown, fallback = 0): number {
  try {
    return toNumber(value, fallback);
  } catch {
    return fallback;
  }
}

/** Sum one numeric column across rows, without a `+` on a string in sight. */
export function sumNumeric<T>(
  rows: readonly T[],
  pick: (row: T) => unknown,
  label?: string,
): number {
  let total = 0;
  for (const row of rows) total += toNumber(pick(row), 0, label);
  return total;
}

/**
 * Round to a currency's minor unit.
 *
 * Money read as a string and converted to a double is exact for every value a
 * `NUMERIC(14,2)` can hold, but arithmetic on doubles is not: `0.1 + 0.2` is
 * `0.30000000000000004`, and written back that is a `NUMERIC` with fourteen
 * decimal places. Round at the point the result becomes an amount again.
 */
export function roundMoney(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) throw new NumericConversionError(value, 'roundMoney');
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Is this value safe to store in a `NUMERIC` column?
 *
 * The database will not tell you. `INSERT ... VALUES ('NaN'::numeric)` succeeds,
 * and so does a `CHECK (col >= 0)` on the row afterwards. Guard on the way in.
 */
export function isStorableNumeric(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  try {
    toNumber(value);
    return true;
  } catch {
    return false;
  }
}
