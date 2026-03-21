/// <reference types="bun-types" />
/**
 * PDF Worker — runs PDF generation in a separate Bun thread.
 * Receives: { type: 'generate', html: string, options: object }
 * Returns:  { type: 'result', buffer: ArrayBuffer }
 *        or { type: 'error', message: string }
 */

import PDFDocument from 'pdfkit';

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as { type: string; html: string; options: Record<string, any> };
  if (msg.type !== 'generate') return;

  try {
    const buffer = await generatePDF(msg.html, msg.options ?? {});
    // Slice to get a standalone ArrayBuffer (not a pooled one) for safe transfer
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    self.postMessage({ type: 'result', buffer: ab }, { transfer: [ab] });
  } catch (err: any) {
    self.postMessage({ type: 'error', message: err?.message ?? 'PDF generation failed' });
  }
};

async function generatePDF(html: string, options: Record<string, any>): Promise<Buffer> {
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_: string, level: string, content: string) =>
      `\n__H${level}__${content.replace(/<[^>]+>/g, '')}__END__\n`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: options.pageSize ?? options.page_size ?? 'A4',
      layout: options.orientation ?? 'portrait',
      margin: options.margin ?? 60,
      info: {
        Title: options.title ?? 'Document',
        Author: options.author ?? 'Zveltio',
        Subject: options.subject ?? '',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const line of text.split('\n')) {
      const h1 = line.match(/^__H1__(.*)__END__$/);
      const h2 = line.match(/^__H2__(.*)__END__$/);
      const h3 = line.match(/^__H[3-6]__(.*)__END__$/);

      if (h1) {
        doc.fontSize(20).font('Helvetica-Bold').text(h1[1].trim(), { lineBreak: true });
        doc.fontSize(11).font('Helvetica');
      } else if (h2) {
        doc.fontSize(16).font('Helvetica-Bold').text(h2[1].trim(), { lineBreak: true });
        doc.fontSize(11).font('Helvetica');
      } else if (h3) {
        doc.fontSize(13).font('Helvetica-Bold').text(h3[1].trim(), { lineBreak: true });
        doc.fontSize(11).font('Helvetica');
      } else if (line.trim() === '') {
        doc.moveDown(0.5);
      } else {
        doc.fontSize(11).font('Helvetica').text(line, { lineBreak: true });
      }
    }

    doc.end();
  });
}
