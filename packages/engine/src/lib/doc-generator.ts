/**
 * Document Generator
 *
 * renderTemplate  — substitute {{variable}} placeholders in HTML template
 * generatePDF     — convert HTML to PDF buffer using PDFKit
 * getNextDocumentNumber — atomically increment counter + return formatted number
 */

import { generatePDFAsync } from './pdf-queue.js';

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
 * Convert HTML string to PDF buffer.
 * Delegates to pdf-queue worker pool to avoid blocking the main thread.
 */
export async function generatePDF(
  htmlContent: string,
  options: { title?: string; author?: string; subject?: string; pageSize?: 'A4' | 'LETTER' } = {},
): Promise<Buffer> {
  return generatePDFAsync(htmlContent, options);
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
