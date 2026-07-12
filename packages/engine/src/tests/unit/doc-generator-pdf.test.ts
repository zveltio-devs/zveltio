/**
 * doc-generator.ts — generatePDF delegates to pdf-queue worker pool.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';

let captured: { html: string; options: Record<string, unknown> } | undefined;

mock.module('../../lib/pdf-queue.js', () => ({
  generatePDFAsync: async (
    html: string,
    options: { title?: string; author?: string; subject?: string; pageSize?: 'A4' | 'LETTER' },
  ) => {
    captured = { html, options };
    return Buffer.from('mock-pdf');
  },
}));

const { generatePDF } = await import('../../lib/doc-generator.js');

afterAll(() => {
  mock.restore();
});

describe('generatePDF', () => {
  it('forwards html and options to generatePDFAsync', async () => {
    const buf = await generatePDF('<p>hi</p>', { title: 'Invoice', pageSize: 'A4' });
    expect(buf.toString()).toBe('mock-pdf');
    expect(captured).toBeDefined();
    expect(captured!.html).toBe('<p>hi</p>');
    expect(captured!.options).toEqual({ title: 'Invoice', pageSize: 'A4' });
  });
});
