/**
 * `/ext/*` must cap request bodies, like `/api/*` does.
 *
 * The limit was mounted on `/api/*` only. Extension handlers call
 * `c.req.formData()` exactly the way the core upload and import handlers do —
 * media upload, CSV import, the SAML callback — which buffers the whole body
 * before anything looks at its size. So a single large request to any
 * extension route was read into memory in full and could take the process
 * down, and unlike the core routes this is third-party code the engine never
 * reviewed: "the handler checks the size itself" was an assumption.
 *
 * Asserted against a route that does not exist. A 404 would mean the body was
 * accepted and routing was reached; the limit has to reject before that.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('/ext/* body limit', () => {
  let app: Hono;

  beforeAll(async () => {
    ({ app } = await getTestApp());
  });

  it('rejects a body over the ceiling before routing', async () => {
    // Over the 105 MB default. Declared via Content-Length so the check can
    // refuse it without the test allocating it.
    const res = await app.request('/ext/does-not-exist/anything', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(200 * 1024 * 1024),
      },
      body: 'x',
    });
    expect(res.status).toBe(413);
  });

  it('lets an ordinary body through to routing', async () => {
    // The limit must not become a wall in front of every extension: a small
    // body still reaches the router, which answers 404 for the unknown path.
    const res = await app.request('/ext/does-not-exist/anything', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).not.toBe(413);
  });
});
