/// <reference types="bun-types" />
/**
 * PDF Worker — runs PDF generation in a separate Bun thread.
 * Receives: { type: 'generate', html: string, options: object }
 * Returns:  { type: 'result', buffer: ArrayBuffer }
 *        or { type: 'error', message: string }
 *
 * Replaces pdfkit with pdf-lib for lighter footprint and better performance.
 * PDF-LIB is a modern, pure-JS PDF library with excellent TypeScript support.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as {
    type: string;
    html: string;
    options: Record<string, any>;
  };
  if (msg.type !== 'generate') return;

  try {
    const buffer = await generatePDF(msg.html, msg.options ?? {});
    // Slice to get a standalone ArrayBuffer for safe transfer
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    self.postMessage({ type: 'result', buffer: ab }, { transfer: [ab] });
  } catch (err: any) {
    self.postMessage({
      type: 'error',
      message: err?.message ?? 'PDF generation failed',
    });
  }
};

async function generatePDF(
  html: string,
  options: Record<string, any>,
): Promise<Buffer> {
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(
      /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
      (_: string, level: string, content: string) =>
        `\n__H${level}__${content.replace(/<[^>]+>/g, '')}__END__\n`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const doc = await PDFDocument.create();

  // Set page size and orientation
  const pageSize = options.pageSize ?? options.page_size ?? 'A4';
  const orientation = options.orientation ?? 'portrait';
  const margins = options.margin ?? 60;

  // Map page size strings to PDF-LIB page sizes
  const pageSizeMap: Record<string, [number, number]> = {
    A4: [595.28, 841.89],
    A3: [841.89, 1190.55],
    A5: [595.28, 841.89],
    Letter: [612, 792],
    Legal: [612, 1008],
  };

  const size = pageSizeMap[pageSize] || [595.28, 841.89];
  let width = size[0];
  let height = size[1];

  if (orientation === 'landscape') {
    [width, height] = [height, width];
  }

  // Add page
  const page = doc.addPage([width, height]);
  const fontSize = 11;

  // Embed fonts (pdf-lib API uses embedFont, not getFont)
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Draw text with formatting
  const lines = text.split('\n');
  let y = height - margins;
  let currentFontSize = fontSize;

  for (const line of lines) {
    const h1 = line.match(/^__H1__(.*)__END__$/);
    const h2 = line.match(/^__H2__(.*)__END__$/);
    const h3 = line.match(/^__H[3-6]__(.*)__END__$/);

    if (h1) {
      const txt = h1[1].trim();
      page.drawText(txt, {
        x: margins,
        y,
        size: 20,
        font,
        color: rgb(0, 0, 0),
      });
      y -= 30;
      currentFontSize = fontSize;
    } else if (h2) {
      const txt = h2[1].trim();
      page.drawText(txt, {
        x: margins,
        y,
        size: 16,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      y -= 25;
      currentFontSize = fontSize;
    } else if (h3) {
      const txt = h3[1].trim();
      page.drawText(txt, {
        x: margins,
        y,
        size: 13,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      y -= 20;
      currentFontSize = fontSize;
    } else if (line.trim() === '') {
      y -= 10;
    } else {
      const wrappedLines = wrapText(line, width - margins * 2, currentFontSize);
      for (const wrappedLine of wrappedLines) {
        page.drawText(wrappedLine, {
          x: margins,
          y,
          size: currentFontSize,
          font,
          color: rgb(0, 0, 0),
        });
        y -= 15;
      }
    }

    if (y < margins + 20) {
      doc.addPage([width, height]);
      y = height - margins;
    }
  }

  // Add document info
  doc.setProducer('Zveltio PDF Generator');
  doc.setCreator('Zveltio');

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length * fontSize * 0.5 < maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}
