/**
 * Document generator (lib/doc-generator.ts).
 *
 * renderTemplate is a pure {{placeholder}} substitutor with HTML escaping
 * (the stored-XSS guard) + ro-RO date/number formatting. getNextDocumentNumber
 * atomically bumps a per-template counter — driven over CannedDb.
 * generatePDF delegates to the pdf-queue worker pool and is covered elsewhere.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { generatePDF, getNextDocumentNumber, renderTemplate } from '../../lib/doc-generator.js';
import * as pdfQueue from '../../lib/pdf-queue.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('renderTemplate', () => {
  it('substitutes trimmed {{keys}} and leaves unknown/nullish as empty string', () => {
    const out = renderTemplate('Hello {{ name }}, code {{missing}}{{ empty }}!', {
      name: 'Ana',
      empty: null,
    });
    expect(out).toBe('Hello Ana, code !');
  });

  it('HTML-escapes substituted values (stored-XSS guard)', () => {
    const out = renderTemplate('{{payload}}', {
      payload: `<script>alert("x&y's")</script>`,
    });
    expect(out).toBe('&lt;script&gt;alert(&quot;x&amp;y&#39;s&quot;)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('formats numbers and ISO dates (ro-RO) and coerces other types', () => {
    const num = renderTemplate('{{total}}', { total: 1234567 });
    // ro-RO groups thousands (with a separator char); the raw digits survive
    expect(num.replace(/\D/g, '')).toBe('1234567');

    const date = renderTemplate('{{when}}', { when: '2026-07-09' });
    // reformatted to a locale date string containing the day/month/year digits
    expect(date).toMatch(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/);

    expect(renderTemplate('{{flag}}', { flag: true })).toBe('true');
  });

  it('returns the template unchanged when there are no placeholders', () => {
    expect(renderTemplate('plain text', {})).toBe('plain text');
  });
});

describe('getNextDocumentNumber', () => {
  it('increments the counter and formats {prefix}{counter}/{year}', async () => {
    const db = new CannedDb();
    db.when(/UPDATE zv_doc_templates/i, [{ counter: 42 }]);
    const year = new Date().getFullYear();

    const num = await getNextDocumentNumber(db.kysely as unknown as Database, 'tmpl-1', 'INV-');
    expect(num).toBe(`INV-42/${year}`);

    const q = db.executed(/UPDATE zv_doc_templates/i)[0]!;
    expect(q.sql).toContain('counter = counter + 1');
    expect(q.parameters).toContain('tmpl-1');
  });

  it('defaults to counter 1 when the update returns no row', async () => {
    const db = new CannedDb();
    db.when(/UPDATE zv_doc_templates/i, []);
    const year = new Date().getFullYear();
    const num = await getNextDocumentNumber(db.kysely as unknown as Database, 'missing', 'PV-');
    expect(num).toBe(`PV-1/${year}`);
  });
});

describe('generatePDF', () => {
  afterEach(() => {
    spyOn(pdfQueue, 'generatePDFAsync').mockRestore();
  });

  it('delegates to generatePDFAsync in the pdf-queue worker pool', async () => {
    let captured: { html: string; options: Record<string, unknown> } | undefined;
    spyOn(pdfQueue, 'generatePDFAsync').mockImplementation(
      async (html: string, options?: Record<string, unknown>) => {
        captured = { html, options: options ?? {} };
        return Buffer.from('mock-pdf');
      },
    );
    const buf = await generatePDF('<p>hi</p>', { title: 'Invoice', pageSize: 'A4' });
    expect(buf.toString()).toBe('mock-pdf');
    expect(captured).toBeDefined();
    expect(captured!.html).toBe('<p>hi</p>');
    expect(captured!.options).toEqual({ title: 'Invoice', pageSize: 'A4' });
  });
});
