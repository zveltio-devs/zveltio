/**
 * document-indexer.ts — PDF extraction when pdf-parse is available (mocked).
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';

mock.module('pdf-parse', () => ({
  default: async () => ({ text: 'parsed pdf body' }),
}));

const { extractTextFromFile } = await import('../../lib/cloud/document-indexer.js');

afterAll(() => {
  mock.restore();
});

describe('extractTextFromFile — pdf-parse available', () => {
  it('returns parsed text from pdf-parse', async () => {
    expect(await extractTextFromFile(Buffer.from('%PDF-1.4'), 'application/pdf')).toBe(
      'parsed pdf body',
    );
  });

  it('returns null and warns when pdf-parse throws', async () => {
    mock.restore();
    mock.module('pdf-parse', () => ({
      default: async () => {
        throw new Error('bad pdf');
      },
    }));
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.join(' '));
    try {
      expect(await extractTextFromFile(Buffer.from('%PDF'), 'application/pdf')).toBeNull();
      expect(warns.join('\n')).toMatch(/PDF text extraction failed/);
    } finally {
      console.warn = orig;
    }
  });
});
