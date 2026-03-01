/**
 * Document Generator
 *
 * renderTemplate  — substitute {{variable}} placeholders in HTML template
 * generatePDF     — convert HTML to PDF buffer using PDFKit
 * getNextDocumentNumber — atomically increment counter + return formatted number
 */

import PDFDocument from 'pdfkit';

/**
 * Substitute {{variable}} placeholders in a template string.
 */
export function renderTemplate(template: string, variables: Record<string, any>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
    const value = variables[key.trim()];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return new Date(value).toLocaleDateString('ro-RO');
    }
    if (typeof value === 'number') return value.toLocaleString('ro-RO');
    return String(value);
  });
}

/**
 * Convert HTML string to PDF buffer using PDFKit.
 * Strips HTML tags and renders plain text — for complex layouts use puppeteer.
 */
export async function generatePDF(
  htmlContent: string,
  options: { title?: string; author?: string; subject?: string; pageSize?: 'A4' | 'LETTER' } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: options.pageSize || 'A4',
      margin: 50,
      info: {
        Title: options.title || 'Document',
        Author: options.author || 'Zveltio',
        Subject: options.subject || '',
      },
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const text = htmlContent
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n$1\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n$1\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n$1\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    doc.font('Helvetica').fontSize(11).text(text, { align: 'left', lineGap: 4 });
    doc.end();
  });
}

/**
 * Atomically increment template counter and return formatted document number.
 * Format: {prefix}{counter}/{year}
 */
export async function getNextDocumentNumber(
  db: any,
  templateId: string,
  prefix: string,
): Promise<string> {
  const { sql } = await import('kysely');

  const result = await sql<{ counter: number }>`
    UPDATE zv_doc_templates
    SET counter = counter + 1, updated_at = NOW()
    WHERE id = ${templateId}
    RETURNING counter
  `.execute(db);

  const num = result.rows[0]?.counter || 1;
  const year = new Date().getFullYear();
  return `${prefix}${num}/${year}`;
}
