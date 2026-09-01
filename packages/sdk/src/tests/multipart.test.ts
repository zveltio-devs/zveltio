import { describe, expect, it } from 'bun:test';
import { MULTIPART_REQUIRED, readMultipart } from '../extension/multipart.js';

/**
 * Six upload handlers opened with a bare `await c.req.formData()` and put their
 * "no file provided" 400 on the line after it. `formData()` throws when the body
 * is not multipart, so that 400 was unreachable for exactly the requests it was
 * written for, and they came back as a bare 500 instead.
 *
 * Both directions are asserted here. A guard that rejects everything would also
 * make the suite green, and would break every upload in the product.
 */
const ctxWith = (body: BodyInit | null, headers: Record<string, string> = {}) => {
  const req = new Request('http://x/upload', { method: 'POST', body, headers });
  return { req: { formData: () => req.formData() } };
};

describe('readMultipart', () => {
  it('parses a real multipart body, fields and files alike', async () => {
    const fd = new FormData();
    fd.append('file', new File(['salut'], 'a.txt', { type: 'text/plain' }));
    fd.append('path', '/docs');

    const form = await readMultipart(ctxWith(fd));
    expect(form).not.toBeNull();
    expect((form?.get('file') as File | undefined)?.name).toBe('a.txt');
    expect(form?.get('path')).toBe('/docs');
  });

  it('answers null for every body shape that used to throw', async () => {
    expect(await readMultipart(ctxWith('{}', { 'content-type': 'application/json' }))).toBeNull();
    expect(await readMultipart(ctxWith(null))).toBeNull();
    expect(await readMultipart(ctxWith('salut', { 'content-type': 'text/plain' }))).toBeNull();
  });

  it('does not leak the parser own message to the caller', async () => {
    // The body parser's error reads like "FormData parse error" — nothing a
    // caller can act on, and echoing a parser's internals over HTTP is how
    // request contents end up in error strings.
    expect(MULTIPART_REQUIRED).toEqual({ error: 'Expected a multipart/form-data body.' });
  });
});
