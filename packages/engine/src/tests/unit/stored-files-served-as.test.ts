/**
 * `servedAs` (lib/stored-files.ts, ADR 0033): any type is stored, and only the
 * inline types are displayed. Everything else is a download that cannot run as
 * a document: octet-stream, attachment with the RFC 6266 name, nosniff, sandbox.
 * The S3 driver signs the same answer into a presigned URL.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { S3Driver } from '../../lib/storage/s3-driver.js';
import { servedAs } from '../../lib/stored-files.js';

const SNAP = { ...process.env };
afterEach(() => {
  process.env = { ...SNAP };
});

describe('servedAs', () => {
  it('serves an allowlisted image, recorded as one, inline', () => {
    const s = servedAs('logo.png', 'image/png');
    expect(s.inline).toBe(true);
    expect(s.headers['Content-Type']).toBe('image/png');
    expect(s.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(s.headers['Content-Disposition']).toBeUndefined();
  });

  it('sandboxes an inline SVG', () => {
    const s = servedAs('logo.svg', 'image/svg+xml');
    expect(s.inline).toBe(true);
    expect(s.headers['Content-Security-Policy']).toContain('sandbox');
  });

  it.each([
    ['page.html', 'text/html'],
    ['invite.ics', 'text/calendar'],
    ['message.eml', 'message/rfc822'],
    ['README', 'text/plain'],
    // The name says image; the recorded type (from the bytes) does not.
    ['evil.png', 'application/octet-stream'],
    ['evil.png', 'text/html'],
    // The type says image; the name is not one a browser may display.
    ['evil.html', 'image/png'],
  ])('serves %s (%s) only as a download', (name, type) => {
    const s = servedAs(name, type);
    expect(s.inline).toBe(false);
    expect(s.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    expect(s.headers['Content-Disposition']).toStartWith('attachment; ');
  });

  it('names the download in RFC 6266 form, with no header injection', () => {
    const d = servedAs('Ofertă "final"\r\n.ics', 'text/calendar').disposition!;
    expect(d).toBe(
      `attachment; filename="Ofert_ _final___.ics"; filename*=UTF-8''Ofert%C4%83%20%22final%22%0D%0A.ics`,
    );
  });
});

describe('S3Driver.signedUrl with a download', () => {
  it('signs response-content-type and response-content-disposition into the URL', async () => {
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    process.env.S3_ACCESS_KEY = 'ak';
    process.env.S3_SECRET_KEY = 'sk';
    process.env.S3_BUCKET = 'zveltio';
    const served = servedAs('page.html', 'text/html');
    const u = new URL(await new S3Driver().signedUrl('uploads/2026/x.html', 60, served));
    expect(u.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(u.searchParams.get('response-content-disposition')).toBe(served.disposition!);
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBeTruthy();
    // Inline files keep a plain URL.
    const plain = new URL(
      await new S3Driver().signedUrl('uploads/2026/x.png', 60, servedAs('x.png', 'image/png')),
    );
    expect(plain.searchParams.has('response-content-disposition')).toBe(false);
  });
});
