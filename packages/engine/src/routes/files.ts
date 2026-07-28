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
 */

import { Hono } from 'hono';
import { getStorage, LocalDriver, verifySignedKey } from '../lib/storage/index.js';

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

    // If a signature is present it MUST be valid + unexpired. A request with no
    // signature is treated as public-by-path (same posture as an S3 public URL).
    const sig = c.req.query('sig');
    const exp = c.req.query('exp');
    if (sig || exp) {
      if (!sig || !exp || !verifySignedKey(key, Number(exp), sig)) {
        return c.json({ error: 'Invalid or expired signature' }, 403);
      }
    }

    const obj = await storage.get(key).catch(() => null);
    if (!obj) return c.json({ error: 'Not found' }, 404);

    return new Response(obj.bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': obj.contentType,
        'Content-Length': String(obj.size),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return app;
}
