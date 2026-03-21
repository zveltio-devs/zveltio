declare module 'pdfkit' {
  import { EventEmitter } from 'events';

  interface PDFDocumentOptions {
    size?: string | [number, number];
    layout?: 'portrait' | 'landscape';
    margin?: number;
    margins?: { top?: number; bottom?: number; left?: number; right?: number };
    info?: {
      Title?: string;
      Author?: string;
      Subject?: string;
      Keywords?: string;
      CreationDate?: Date;
    };
  }

  class PDFDocument extends EventEmitter {
    constructor(options?: PDFDocumentOptions);
    font(src: string, size?: number): this;
    fontSize(size: number): this;
    text(text: string, options?: { lineBreak?: boolean; align?: string; lineGap?: number }): this;
    moveDown(lines?: number): this;
    end(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export = PDFDocument;
}
