/**
 * Public file-serving route for the `local` storage driver.
 *
 * The S3 driver hands out object-store URLs the browser fetches directly; the
 * local driver stores bytes on disk, so the engine serves them here. Mounted at
 * `/files/*` on the GLOBAL app (public, like the page-builder CMS) — access is
 * either:
 *   - public-by-unguessable-path (a random UUID key), mirroring the S3
 *     public-bucket URLs the engine already emits, or
 *   - HMAC-signed (`?exp=…&sig=…`) for the private/time-limited case, verified
 *     here (the local equivalent of an S3 presigned GET).
 *
 * Serves HTTP Range requests (`Range: bytes=…`) with `206 Partial Content` +
 * `Accept-Ranges: bytes`, so audio/video can seek and large downloads resume —
 * the S3 driver gets this for free from the object store. Bytes are streamed
 * from disk via `Bun.file` (no full read into memory), so serving a 5-second
 * seek into a 2 GB video reads only the requested slice.
 */

import { stat } from 'node:fs/promises';
import { Hono } from 'hono';
import { getStorage, LocalDriver, safeLocalPath, verifySignedKey } from '../lib/storage/index.js';

/** Read the persisted content-type from the `<file>.meta` sidecar. */
async function contentTypeOf(full: string): Promise<string> {
  const meta = Bun.file(`${full}.meta`);
  if (await meta.exists()) return (await meta.text()).trim() || 'application/octet-stream';
  return 'application/octet-stream';
}

/**
 * Parse a single-range `Range` header against `size`. Returns the inclusive
 * `[start, end]`, `null` when there is no Range header, or `'invalid'` when the
 * range is unsatisfiable (→ 416). Only the common single-range form is handled;
 * multi-range (`bytes=0-1,5-6`) falls back to the full body.
 */
function parseRange(header: string | undefined, size: number): [number, number] | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // suffix range: the last N bytes
    const n = Number(m[2]);
    if (n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size)
    return 'invalid';
  return [start, end];
}

export function filesRoutes(): Hono {
  const app = new Hono();

  app.get('/*', async (c) => {
    const storage = getStorage();
    // Only the local driver serves bytes through the engine; with S3 the URLs
    // point at the object store directly, so nothing is served here.
    if (!(storage instanceof LocalDriver)) return c.json({ error: 'Not found' }, 404);

    // Strip the leading "/files/" to recover the object key.
    const key = decodeURIComponent(c.req.path.replace(/^\/files\//, ''));
    if (!key || key.includes('..')) return c.json({ error: 'Not found' }, 404);
    // Never serve the internal sidecars/temp files the driver writes alongside
    // objects (`.meta` = content-type, `.tmp-…` = in-flight atomic writes).
    if (key.endsWith('.meta') || /\.tmp-[0-9a-f]+$/.test(key)) {
      return c.json({ error: 'Not found' }, 404);
    }

    // If a signature is present it MUST be valid + unexpired. A request with no
    // signature is treated as public-by-path (same posture as an S3 public URL).
    const sig = c.req.query('sig');
    const exp = c.req.query('exp');
    if (sig || exp) {
      if (!sig || !exp || !verifySignedKey(key, Number(exp), sig)) {
        return c.json({ error: 'Invalid or expired signature' }, 403);
      }
    }

    let full: string;
    try {
      full = safeLocalPath(key);
    } catch {
      return c.json({ error: 'Not found' }, 404);
    }
    const st = await stat(full).catch(() => null);
    if (!st || !st.isFile()) return c.json({ error: 'Not found' }, 404);

    const size = st.size;
    const contentType = await contentTypeOf(full);
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };

    const range = parseRange(c.req.header('range'), size);
    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    }

    if (range) {
      const [start, end] = range;
      // Bun.file(...).slice() is a lazy, disk-backed Blob — only the requested
      // bytes are read when the Response body streams.
      const chunk = Bun.file(full).slice(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }

    return new Response(Bun.file(full), {
      headers: { ...headers, 'Content-Length': String(size) },
    });
  });

  return app;
}
